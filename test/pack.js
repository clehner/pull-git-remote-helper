var tape = require('tape')
var pack = require('../pack')
var pull = require('pull-stream')
var repo = require('./repo')
var util = require('../util')

var objects = [
  {type: 'commit', object: repo.commit},
  {type: 'tree', object: repo.tree},
  {type: 'blob', object: repo.file}
]

function sha1(str) {
  return require('crypto').createHash('sha1').update(str).digest('hex')
}

function streamObject(read) {
  var ended
  return function readObject(abort, cb) {
    read(abort, function (end, item) {
      if (ended = end) return cb(end)
      var data = item.object.data
      cb(null, item.type, data.length, pull.once(data))
    })
  }
}

function bufferObject(readObject) {
  var ended
  return function (abort, cb) {
    readObject(abort, function next(end, type, length, read) {
      if (ended = end) return cb(end)
      var hasher = util.createGitObjectHash(type, length)
      pull(
        read,
        hasher,
        pull.collect(function (err, bufs) {
          if (err) console.error(err)
          // console.error('obj', type, length, JSON.stringify(buf.toString('ascii')))
          cb(err, {
            type: type,
            object: {
              hash: hasher.digest('hex'),
              data: Buffer.concat(bufs)
            }
          })
        })
      )
    })
  }
}

tape('pack', function (t) {
  var i = 0
  pull(
    pull.values(objects),
    streamObject,
    pack.encode(objects.length),
    pack.decode(function (err) {
      t.error(err, 'decoded pack')
    }),
    bufferObject,
    pull.drain(function (obj) {
      var a = obj.object
      var b = objects[i].object
      if (a.hash != b.hash)
        console.error(new Buffer(b.data))
        console.error(a.hash, b.hash, a.data.length, b.data.length,
        a.data === b.data,
        '"' + objects[i].type + ' ' + b.data.length + '\0' + b.data + '"',
        sha1(objects[i].type + ' ' + b.data.length + '\0' + b.data))
      if (i < objects.length)
        t.deepEquals(obj, objects[i++])
      else
        t.notOk(obj, 'unexpected object')
    }, function (err) {
      t.error(err, 'got objects')
      t.end()
    })
  )
})
