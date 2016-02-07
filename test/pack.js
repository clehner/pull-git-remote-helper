var tape = require('tape')
var pack = require('../lib/pack')
var pull = require('pull-stream')
var repo = require('./repo')
var util = require('../lib/util')

var objects = [
  {type: 'commit', object: repo.commit},
  {type: 'tree', object: repo.tree},
  {type: 'blob', object: repo.file}
]

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
