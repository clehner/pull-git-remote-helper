var pull = require('pull-stream')
var cat = require('pull-cat')
var cache = require('pull-cache')
var buffered = require('pull-buffered')
var Repo = require('pull-git-repo')
var pack = require('pull-git-pack')
var pktLine = require('./lib/pkt-line')
var indexPack = require('pull-git-pack/lib/index-pack')
var util = require('./lib/util')
var multicb = require('multicb')
var ProgressBar = require('progress')
var pkg = require('./package.json')

var agentCap = 'agent=' + pkg.name + '/' + pkg.version

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
    agentCap,
  ], repo.refs(), repo.symrefs())

  var lines = pktLine.decode(read, {
    onCaps: onCaps,
    verbosity: options.verbosity
  })
  var readWantHave = lines.haves()
  var acked
  var commonHash
  var sendPack
  var wants = {}
  var shallows = {}
  var aborted
  var hasWants
  var gotHaves

  function onCaps(caps) {
  }

  function readWant(abort, cb) {
    if (abort) return
    // read upload request (wants list) from client
    readWantHave(null, function next(end, want) {
      if (end || want.type == 'flush-pkt') {
        cb(end || true, cb)
        return
      }
      if (want.type == 'want') {
        wants[want.hash] = true
        hasWants = true
      } else if (want.type == 'shallow') {
        shallows[want.hash] = true
      } else {
        var err = new Error("Unknown thing", want.type, want.hash)
        return readWantHave(err, function (e) { cb(e || err) })
      }
      readWantHave(null, next)
    })
  }

  function readHave(abort, cb) {
    // Read upload haves (haves list).
    // On first obj-id that we have, ACK
    // If we have none, NAK.
    // TODO: implement multi_ack_detailed
    // FIXME!
    if (abort) return
    if (gotHaves) return cb(true)
    readWantHave(null, function next(end, have) {
      if (end === true) {
        gotHaves = true
        if (!acked) {
          cb(null, 'NAK')
        } else {
          cb(true)
        }
      } else if (have.type === 'flush-pkt') {
        // found no common object
        if (!acked) {
          cb(null, 'NAK')
        } else {
          readWantHave(null, next)
        }
      } else if (end)
        cb(end)
      else if (have.type != 'have')
        cb(new Error('Unknown have' + JSON.stringify(have)))
      else if (acked)
        readWantHave(null, next)
      else
        repo.hasObjectFromAny(have.hash, function (err, haveIt) {
          if (err) return cb(err)
          if (!haveIt)
            return readWantHave(null, next)
          commonHash = haveIt
          acked = true
          cb(null, 'ACK ' + have.hash)
        })
    })
  }

  function readPack(abort, cb) {
    if (abort || aborted) return console.error('abrt', abort || aborted), cb(abort || aborted)
    if (sendPack) return sendPack(abort, cb)
    // send pack file to client
    if (!hasWants) return cb(true)
    if (options.verbosity >= 2) {
      console.error('common', commonHash, 'wants', wants)
    }
    // TODO: show progress during getObjects
    getObjects(repo, commonHash, wants, shallows,
      function (err, numObjects, readObjects) {
        if (err) return cb(err)
        // var progress = progressObjects(options)
        // progress.setNumObjects(numObjects)
        sendPack = pack.encode(options, numObjects, readObjects)
        if (options.verbosity >= 1) {
          console.error('retrieving', numObjects, 'git objects')
        }
        sendPack(null, cb)
      }
    )
  }

  // Packfile negotiation
  return cat([
    pktLine.encode(cat([
      sendRefs,
      pull.once(''),
      readWant,
      readHave
    ])),
    readPack
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
    // console.error(objects.reduce(function (n, obj) { return obj.length + n}, 0) + ' bytes')
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
    var mode = parseInt(buf.slice(i, j).toString('ascii'), 8)
    if (mode == 0160000) {
      // skip link to git commit since it may not be in this repo
      continue
    }
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
function receivePackHeader(capabilities, refSource, symrefs) {
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
        if (first) {
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
    agentCap,
    'delete-refs',
    'no-thin',
  ], repo.refs(), null)
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

            var hasPack = !updates.every(function (update) {
              return update.new === null
            })
            if (!hasPack) {
              return repo.update(pull.values(updates), pull.empty(), done())
            }

            if (repo.uploadPack) {
              var idxCb = done()
              indexPack(lines.passthrough, function (err, idx, packfileFixed) {
                if (err) return idxCb(err)
                repo.uploadPack(pull.values(updates), pull.once({
                  pack: pull(
                    packfileFixed,
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
    verbosity: +process.env.GIT_VERBOSITY || 1,
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
    if (options.verbosity >= 3) {
      read = pull.through(function (data) {
        console.error('>', JSON.stringify(data.toString('ascii')))
      })(read)
    }
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
          if (options.verbosity >= 3) {
            console.error('<', JSON.stringify(data))
          }
          cb(null, data)
        }
      })
    }
  }
}
