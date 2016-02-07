var packCodec = require('js-git/lib/pack-codec')
var pull = require('pull-stream')
var cat = require('pull-cat')
var buffered = require('pull-buffered')
var pack = require('./pack')

function handleOption(options, name, value) {
  switch (name) {
    case 'verbosity':
      options.verbosity = +value || 0
      return true
    case 'progress':
      options.progress = !!value && value !== 'false'
      return true
    default:
      console.error('unknown option', name + ': ' + value)
      return false
  }
}

function capabilitiesSource(prefix) {
  return pull.once([
    'option',
    'connect',
    'refspec refs/heads/*:refs/' + prefix + '/heads/*',
    'refspec refs/tags/*:refs/' + prefix + '/tags/*',
  ].join('\n') + '\n\n')
}

function split2(str, delim) {
  var i = str.indexOf(delim || ' ')
  return (i === -1) ? [str, ''] : [
    str.substr(0, i),
    str.substr(i + 1)
  ]
}

function split3(str) {
  var args = split2(str)
  return [args[0]].concat(split2(args[1]))
}

function optionSource(cmd, options) {
  var args = split2(cmd)
  var msg = handleOption(options, args[0], args[1])
  msg = (msg === true) ? 'ok'
      : (msg === false) ? 'unsupported'
      : 'error ' + msg
  return pull.once(msg + '\n')
}

// transform ref objects into lines
function listRefs(read) {
  var ended
  return function (abort, cb) {
    if (ended) return cb(ended)
    read(abort, function (end, ref) {
      ended = end
      if (end === true) cb(null, '\n')
      if (end) cb(end)
      else cb(null,
        [ref.value, ref.name].concat(ref.attrs || []).join(' ') + '\n')
    })
  }
}

function uploadPack(read, objectSource, refSource, options) {
  /* multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress
   * include-tag multi_ack_detailed symref=HEAD:refs/heads/master
   * agent=git/2.7.0 */
  var sendRefs = receivePackHeader([
  ], refSource, false)

  var wantsSink = pull.drain(function (want) {
    console.error('want', want)
  })

  return packLineEncode(
    cat([
      sendRefs,
      pull.once(''),
      function (abort, cb) {
        if (abort) return
        // read client wants
        var lines = packLineDecode(read, options)
        pull(
          lines.wants,
          onThroughEnd(wantsDone),
          wantsSink
        )
        function wantsDone(err) {
          if (err) return cb(err)
          pull(
            lines.passthrough,
            pull.drain(function (buf) {
              console.error('got buf after wants', buf)
            })
          )
        }
      }
    ])
  )
}

function packLineEncode(read) {
  var ended
  return function (end, cb) {
    if (ended) return cb(ended)
    read(end, function (end, data) {
      if (ended = end) {
        cb(end)
      } else {
        var len = data ? data.length + 5 : 0
        cb(end, ('000' + len.toString(16)).substr(-4) + data + '\n')
      }
    })
  }
}

function rev(str) {
  return str === '0000000000000000000000000000000000000000' ? null : str
}

function packLineDecode(read, options) {
  var b = buffered(read)
  var readPrefix = b.chunks(4)
  var ended

  function readPackLine(abort, cb) {
    readPrefix(abort, function (end, buf) {
      if (ended = end) return cb(end)
      var len = parseInt(buf, 16)
      if (!len)
        return cb(null, new Buffer(''))
      // TODO: figure out this -4 thing
      b.chunks(len - 4)(null, function (end, buf) {
        if (ended = end) return cb(end)
        cb(end, buf)
      })
    })
  }

  function readUpdate(abort, cb) {
    readPackLine(abort, function (end, line) {
      if (end) return cb(end)
      if (options.verbosity >= 2)
        console.error('line', line.toString('ascii'))
      if (!line.length) return cb(true)
      var args = split3(line.toString('ascii'))
      var args2 = split2(args[2], '\0')
      var caps = args2[1]
      if (caps && options.verbosity >= 2)
        console.error('update capabilities:', caps)
      cb(null, {
        old: rev(args[0]),
        new: rev(args[1]),
        name: args2[0]
      })
    })
  }

  function readWant(abort, cb) {
    readPackLine(abort, function (end, line) {
      if (end) return cb(end)
      if (options.verbosity >= 2)
        console.error('line', line.toString('ascii'))
      if (!line.length || line == 'done') return cb(true)
      var args = split3(line.toString('ascii'))
      var caps = args[2]
      if (caps && options.verbosity >= 2)
        console.error('want capabilities:', caps)
      cb(null, {
        type: args[0],
        hash: args[1],
      })
    })
  }

  b.packLines = readPackLine
  b.updates = readUpdate
  b.wants = readWant

  return b
}

// run a callback when a pipeline ends
// TODO: find a better way to do this
function onThroughEnd(onEnd) {
  return function (read) {
    return function (end, cb) {
      read(end, function (end, data) {
        cb(end, data)
        if (end)
          onEnd(end === true ? null : end)
      })
    }
  }
}

/*
TODO: investigate capabilities
report-status delete-refs side-band-64k quiet atomic ofs-delta
*/

// Get a line for each ref that we have. The first line also has capabilities.
// Wrap with packLineEncode.
function receivePackHeader(capabilities, refSource, usePlaceholder) {
  var first = true
  var ended
  return function (abort, cb) {
    if (ended) return cb(true)
    refSource(abort, function (end, ref) {
      ended = end
      var name = ref && ref.name
      var value = ref && ref.value
      if (first && usePlaceholder) {
        first = false
        if (end) {
          // use placeholder data if there are no refs
          value = '0000000000000000000000000000000000000000'
          name = 'capabilities^{}'
        }
        name += '\0' + capabilities.join(' ')
      } else if (end) {
        return cb(true)
      }
      cb(null, value + ' ' + name)
    })
  }
}

function receivePack(read, objectSink, refSource, refSink, options) {
  var ended
  var sendRefs = receivePackHeader([], refSource, true)

  return packLineEncode(
    cat([
      // send our refs
      sendRefs,
      pull.once(''),
      function (abort, cb) {
        if (abort) return
        // receive their refs
        var lines = packLineDecode(read, options)
        pull(
          lines.updates,
          onThroughEnd(refsDone),
          refSink
        )
        function refsDone(err) {
          if (err) return cb(err)
          pull(
            lines.passthrough,
            pack.decode(cb),
            objectSink
          )
        }
      },
      pull.once('unpack ok')
    ])
  )
}

function prepend(data, read) {
  var done
  return function (end, cb) {
    if (done) {
      read(end, cb)
    } else {
      done = true
      cb(null, data)
    }
  }
}

module.exports = function (opts) {
  var ended
  var prefix = opts.prefix
  var objectSink = opts.objectSink
  var objectSource = opts.objectSource || pull.empty()
  var refSource = opts.refSource || pull.empty()
  var refSink = opts.refSink || pull.drain()

  var options = {
    verbosity: 1,
    progress: false
  }

  function handleConnect(cmd, read) {
    var args = split2(cmd)
    switch (args[0]) {
      case 'git-upload-pack':
        return prepend('\n', uploadPack(read, objectSource, refSource(),
          options))
      case 'git-receive-pack':
        return prepend('\n', receivePack(read, objectSink, refSource(),
          refSink, options))
      default:
        return pull.error(new Error('Unknown service ' + args[0]))
    }
  }

  function handleCommand(line, read) {
    var args = split2(line)
    switch (args[0]) {
      case 'capabilities':
        return capabilitiesSource(prefix)
      case 'list':
        return listRefs(refSource())
      case 'connect':
        return handleConnect(args[1], read)
      case 'option':
        return optionSource(args[1], options)
      default:
        return pull.error(new Error('Unknown command ' + line))
    }
  }

  return function (read) {
    var b = buffered()
    b(read)
    var command

    function getCommand(cb) {
      b.lines(null, function next(end, line) {
        if (ended = end)
          return cb(end)

        if (line == '')
          return b.lines(null, next)

        if (options.verbosity > 1)
          console.error('command:', line)

        var cmdSource = handleCommand(line, b.passthrough)
        cb(null, cmdSource)
      })
    }

    return function next(abort, cb) {
      if (ended) return cb(ended)

      if (!command) {
        if (abort) return
        getCommand(function (end, cmd) {
          command = cmd
          next(end, cb)
        })
        return
      }

      command(abort, function (err, data) {
        if (err) {
          command = null
          if (err !== true)
            cb(err, data)
          else
            next(abort, cb)
        } else {
          cb(null, data)
        }
      })
    }
  }
}
