#!/usr/bin/env node

var toPull = require('stream-to-pull-stream')
var pull = require('pull-stream')
var repo = require('../repo')

process.on('uncaughtException', function (err) {
  if (err.stack)
    err = {stack: err.stack, message: err.message}
  process.send({error: err})
  process.exit(1)
})

var HEAD = 'edb5b50e8019797925820007d318870f8c346726'
var refs = [
  {name: 'refs/heads/master', value: HEAD},
  {name: 'HEAD', value: HEAD}
]

var objects = [
  {type: 'commit', object: repo.commit},
  {type: 'tree', object: repo.tree},
  {type: 'blob', object: repo.file}
]

var hashes = {}
hashes[repo.commit.hash] = 1
hashes[repo.tree.hash] = 1
hashes[repo.file.hash] = 1

function streamObject(read) {
  var ended
  return function readObject(abort, cb) {
    read(abort, function (end, item) {
      if (ended = end) return cb(end)
      var data = item.object.data
      cb(null, {
        type: item.type,
        length: data.length,
        read: pull.once(data)
      })
    })
  }
}

pull(
  toPull(process.stdin),
  require('../../')({
    refSource: pull.values(refs),
    wantSink: pull.drain(function (want) {
      process.send({want: want})
    }),
    hasObject: function (hash, cb) {
      cb(hash in hashes)
    },
    getObjects: function (ancestorHash, cb) {
      cb(null, objects.length, pull(
        pull.values(objects),
        streamObject
      ))
    }
  }),
  toPull(process.stdout, function (err) {
    if (err)
      throw err
    process.disconnect()
  })
)
