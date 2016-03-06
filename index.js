var pull = require('pull-stream')
var cat = require('pull-cat')
var cache = require('pull-cache')
var buffered = require('pull-buffered')
var Repo = require('pull-git-repo')
var pack = require('pull-git-pack')
var pktLine = require('./lib/pkt-line')
var indexPack = require('./lib/index-pack')
var util = require('./lib/util')
var multicb = require('multicb')
var ProgressBar = require('progress')

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
  /* multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress
   * include-tag multi_ack_detailed
   * agent=git/2.7.0 */
  var sendRefs = receivePackHeader([
    'thin-pack',
  ], repo.refs(), repo.symrefs(), false)

  var lines = pktLine.decode(read, options)
  var readHave = lines.haves()
  var acked
  var commonHash
  var sendPack
  var wants = {}
  var shallows = {}

  // Packfile negotiation
  return cat([
    pktLine.encode(cat([
      sendRefs,
      pull.once(''),
      function (abort, cb) {
        if (abort) return
        if (acked) return cb(true)

        // read upload request (wants list) from client
        var readWant = lines.wants()
        readWant(null, function (end, want) {
          if (end === true) return cb(true) // early client disconnect
          else if (end) cb(end)
          else nextWant(null, want)
        })
        function nextWant(end, want) {
          if (end) return wantsDone(end === true ? null : end)
          if (want.type == 'want') {
            wants[want.hash] = true
          } else if (want.type == 'shallow') {
            shallows[want.hash] = true
          } else {
            var err = new Error("Unknown thing", want.type, want.hash)
            return readWant(err, function (e) { cb(e || err) })
          }
          readWant(null, nextWant)
        }

        function wantsDone(err) {
          if (err) return cb(err)
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
              repo.hasObjectFromAny(have.hash, function (err, haveIt) {
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
      if (abort) return cb(abort)
      // send pack file to client
      if (sendPack)
        return sendPack(abort, cb)
      getObjects(repo, commonHash, wants, shallows,
        function (err, numObjects, readObjects) {
          if (err) return cb(err)
          var progress = progressObjects(options)
          progress.setNumObjects(numObjects)
          sendPack = pack.encode(options, numObjects,
            progress(readObjects))
          havesDone(abort, cb)
        }
      )
    }
  ])
}

// through stream to show a progress bar for objects being read
function progressObjects(options) {
  // Only show progress bar if it is requested and if it won't interfere with
  // the debug output
  if (!options.progress || options.verbosity > 1) {
    var dummyProgress = function (readObject) { return readObject }
    dummyProgress.setNumObjects = function () {}
    return dummyProgress
  }

  var numObjects
  var size = process.stderr.columns
  var bar = new ProgressBar(':percent :bar', {
    total: size,
    clear: true
  })

  var progress = function (readObject) {
    return function (abort, cb) {
      readObject(abort, function next(end, object) {
        if (end === true) {
          bar.terminate()
        } else if (!end) {
          var name = object.type + ' ' + object.length
          bar.tick(size / numObjects)
        }

        cb(end, object)
      })
    }
  }
  // TODO: put the num objects in the objects stream as a header object
  progress.setNumObjects = function (n) {
    numObjects = n
  }
  return progress
}

function getObjects(repo, commonHash, heads, shallows, cb) {
  // get objects from commonHash to each head, inclusive.
  // if commonHash is falsy, use root
  var objects = []
  var objectsAdded = {}
  var done = multicb({pluck: 1})
  var ended

  // walk back from heads until get to commonHash
  for (var hash in heads)
    addObject(hash, done())

  // TODO: only add new objects

  function addObject(hash, cb) {
    if (ended) return cb(ended)
    if (hash in objectsAdded || hash == commonHash) return cb()
    objectsAdded[hash] = true
    repo.getObjectFromAny(hash, function (err, object) {
      if (err) return cb(err)
      if (object.type == 'blob') {
        objects.push(object)
        cb()
      } else {
        // object must be read twice, so buffer it
        bufferObject(object, function (err, object) {
          if (err) return cb(err)
          objects.push(object)
          var hashes = getObjectLinks(object)
          for (var sha1 in hashes)
            addObject(sha1, done())
          cb()
        })
      }
    })
  }

  done(function (err) {
    if (err) return cb(err)
    cb(null, objects.length, pull.values(objects))
  })
}

function bufferObject(object, cb) {
  pull(
    object.read,
    pull.collect(function (err, bufs) {
      if (err) return cb(err)
      var buf = Buffer.concat(bufs, object.length)
      cb(null, {
        type: object.type,
        length: object.length,
        data: buf,
        read: pull.once(buf)
      })
    })
  )
}

// get hashes of git objects linked to from other git objects
function getObjectLinks(object, cb) {
  switch (object.type) {
    case 'blob':
      return {}
    case 'tree':
      return getTreeLinks(object.data)
    case 'tag':
    case 'commit':
      return getCommitOrTagLinks(object.data)
  }
}

function getTreeLinks(buf) {
  var links = {}
  for (var i = 0, j; j = buf.indexOf(0, i, 'ascii') + 1; i = j + 20) {
    var hash = buf.slice(j, j + 20).toString('hex')
    if (!(hash in links))
      links[hash] = true
  }
  return links
}

function getCommitOrTagLinks(buf) {
  var lines = buf.toString('utf8').split('\n')
  var links = {}
  // iterate until reach blank line (indicating start of commit/tag body)
  for (var i = 0; lines[i]; i++) {
    var args = lines[i].split(' ')
    switch (args[0]) {
      case 'tree':
      case 'parent':
      case 'object':
        var hash = args[1]
        if (!(hash in links))
          links[hash] = true
    }
  }
  return links
}

/*
TODO: investigate capabilities
report-status delete-refs side-band-64k quiet atomic ofs-delta
*/

// Get a line for each ref that we have. The first line also has capabilities.
// Wrap with pktLine.encode.
function receivePackHeader(capabilities, refSource, symrefs, usePlaceholder) {
  var first = true
  var symrefed = {}
  var symrefsObj = {}

  return cat([
    function (end, cb) {
      if (end) cb(true)
      else if (!symrefs) cb(true)
      else pull(
        symrefs,
        pull.map(function (sym) {
          symrefed[sym.ref] = true
          symrefsObj[sym.name] = sym.ref
          return 'symref=' + sym.name + ':' + sym.ref
        }),
        pull.collect(function (err, symrefCaps) {
          if (err) return cb(err)
          capabilities = capabilities.concat(symrefCaps)
          cb(true)
        })
      )
    },
    pull(
      refSource,
      pull.map(function (ref) {
        // insert symrefs next to the refs that they point to
        var out = [ref]
        if (ref.name in symrefed)
          for (var symrefName in symrefsObj)
            if (symrefsObj[symrefName] === ref.name)
              out.push({name: symrefName, hash: ref.hash})
        return out
      }),
      pull.flatten(),
      pull.map(function (ref) {
        var name = ref.name
        var value = ref.hash
        if (first && usePlaceholder) {
          first = false
          /*
          if (end) {
            // use placeholder data if there are no refs
            value = '0000000000000000000000000000000000000000'
            name = 'capabilities^{}'
          }
          */
          name += '\0' + capabilities.join(' ')
        }
        return value + ' ' + name
      })
    )
  ])
}

// receive-pack: push from client
function receivePack(read, repo, options) {
  var sendRefs = receivePackHeader([
    'delete-refs',
  ], repo.refs(), null, true)
  var done = multicb({pluck: 1})

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
            if (updates.length === 0) return cb(true)
            var progress = progressObjects(options)

            if (repo.uploadPack) {
              var idxCb = done()
              var packfile = cache(lines.passthrough)
              indexPack(packfile(), function (err, idx) {
                if (err) return idxCb(err)
                repo.uploadPack(pull.values(updates), pull.once({
                  pack: pull(
                    packfile(),
                    // for some reason i was getting zero length buffers which
                    // were causing muxrpc to fail, so remove them here.
                    pull.filter(function (buf) {
                      return buf.length
                    })
                  ),
                  idx: idx
                }), idxCb)
              })
            } else {
              repo.update(pull.values(updates), pull(
                lines.passthrough,
                pack.decode({
                  verbosity: options.verbosity,
                  onHeader: function (numObjects) {
                    progress.setNumObjects(numObjects)
                  }
                }, repo, done()),
                progress
              ), done())
            }

            done(function (err) {
              cb(err || true)
            })
          })
        )
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
  var options = {
    verbosity: 1,
    progress: false
  }

  repo = Repo(repo)

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
          // HACK: silence error when writing to closed stream
          try {
            cb(null, data)
          } catch(e) {
            if (e.message == 'process.stdout cannot be closed.'
             || e.message == 'This socket is closed.')
              process.exit(1)
            throw e
          }
        }
      })
    }
  }
}
