var packCodec = require('js-git/lib/pack-codec')
var pull = require('pull-stream')
var cat = require('pull-cat')
var buffered = require('pull-buffered')
var pack = require('./lib/pack')
var pktLine = require('./lib/pkt-line')
var util = require('./lib/util')

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

function capabilitiesSource() {
  return pull.once([
    'option',
    'connect',
  ].join('\n') + '\n\n')
}

function optionSource(cmd, options) {
  var args = util.split2(cmd)
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

// upload-pack: fetch to client
function uploadPack(read, repo, options) {
  // getObjects, wantSink
  /* multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress
   * include-tag multi_ack_detailed symref=HEAD:refs/heads/master
   * agent=git/2.7.0 */
  var refSource = repo.refs.bind(repo)
  var sendRefs = receivePackHeader([
  ], refSource, false)

  var lines = pktLine.decode(read, options)
  var readHave = lines.haves()
  var acked
  var commonHash
  var sendPack
  var earlyDisconnect

  // Packfile negotiation
  return cat([
    pktLine.encode(cat([
      sendRefs,
      pull.once(''),
      function (abort, cb) {
        if (abort) return
        if (acked) return cb(true)
        // read upload request (wants list) from client
        var readWant = lines.wants(wantsDone)
        readWant(null, function (end, want) {
          if (end === true) {
            // client disconnected before sending wants
            earlyDisconnect = true
            cb(true)
          } else if (end) {
            cb(end)
          } else {
            wantSink(readWant)
          }
        })

        function wantsDone(err) {
          // console.error('wants done', err, earlyDisconnect)
          if (err) return cb(err)
          if (earlyDisconnect) return cb(true)
          // Read upload haves (haves list).
          // On first obj-id that we have, ACK
          // If we have none, NAK.
          // TODO: implement multi_ack_detailed
          readHave(null, function next(end, have) {
            if (end === true) {
              // found no common object
              acked = true
              cb(null, 'NAK')
            } else if (end)
              cb(end)
            else if (have.type != 'have')
              cb(new Error('Unknown have' + JSON.stringify(have)))
            else
              repo.hasObject(have.hash, function (err, haveIt) {
                if (err) return cb(err)
                if (!haveIt)
                  return readHave(null, next)
                commonHash = haveIt
                acked = true
                cb(null, 'ACK ' + have.hash)
              })
          })
        }
      },
    ])),
    function havesDone(abort, cb) {
      // console.error("haves done", abort && typeof abort, sendPack && typeof sendPack, abort, earlyDisconnect)
      if (abort || earlyDisconnect) return cb(abort || true)
      // send pack file to client
      if (!sendPack)
        getObjects(commonHash, function (err, numObjects, readObject) {
          sendPack = pack.encode(numObjects, readObject)
          havesDone(abort, cb)
        })
      else
        sendPack(abort, cb)
    }
  ])
}

/*
TODO: investigate capabilities
report-status delete-refs side-band-64k quiet atomic ofs-delta
*/

// Get a line for each ref that we have. The first line also has capabilities.
// Wrap with pktLine.encode.
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

// receive-pack: push from client
function receivePack(read, repo, options) {
  var ended
  var refSource = repo.refs.bind(repo)
  var sendRefs = receivePackHeader([
    'delete-refs',
  ], refSource, true)

  return pktLine.encode(
    cat([
      // send our refs
      sendRefs,
      pull.once(''),
      function (abort, cb) {
        if (abort) return
        // receive their refs
        var lines = pktLine.decode(read, options)
        pull(
          lines.updates,
          pull.collect(function (err, updates) {
            if (err) return cb(err)
            repo.update(pull.values(updates), pull(
              lines.passthrough,
              pack.decode(onEnd)
            ), onEnd)
          })
        )
        function onEnd(err) {
          if (!ended)
            cb(ended = err)
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

module.exports = function (repo) {
  var ended
  /*
  var getObjects = opts.getObjects || function (id, cb) {
    cb(null, 0, pull.empty())
  }
  */

  var options = {
    verbosity: 1,
    progress: false
  }

  function handleConnect(cmd, read) {
    var args = util.split2(cmd)
    switch (args[0]) {
      case 'git-upload-pack':
        return prepend('\n', uploadPack(read, repo, options))
      case 'git-receive-pack':
        return prepend('\n', receivePack(read, repo, options))
      default:
        return pull.error(new Error('Unknown service ' + args[0]))
    }
  }

  function handleCommand(line, read) {
    var args = util.split2(line)
    switch (args[0]) {
      case 'capabilities':
        return capabilitiesSource()
      case 'list':
        return listRefs(refSource)
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
