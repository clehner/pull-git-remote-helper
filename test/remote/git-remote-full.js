#!/usr/bin/env node

var toPull = require('stream-to-pull-stream')
var pull = require('pull-stream')
var repo = require('pull-git-pack/test/repo')

process.on('uncaughtException', function (err) {
  if (err.stack)
    err = {stack: err.stack, message: err.message}
  process.send({error: err})
  process.exit(1)
})

var HEAD = 'edb5b50e8019797925820007d318870f8c346726'
var refs = [
  {name: 'refs/heads/master', hash: HEAD},
  {name: 'HEAD', hash: HEAD}
]

var objects = [
  {type: 'commit', object: repo.commit},
  {type: 'tree', object: repo.tree},
  {type: 'blob', object: repo.file}
]

var hashes = {}
hashes[repo.commit.hash] = objects[0]
hashes[repo.tree.hash] = objects[1]
hashes[repo.file.hash] = objects[2]

pull(
  toPull(process.stdin),
  require('../../')({
    refs: function () { return pull.values(refs) },
    symrefs: pull.empty,
    wantSink: pull.drain(function (want) {
      process.send({want: want})
    }),
    hasObject: function (hash, cb) {
      cb(null, hash in hashes)
    },
    getObject: function (hash, cb) {
      var item = hashes[hash]
      if (!item) return cb(new Error('Object not present with hash ' + hash))
      cb(null, {
        type: item.type,
        length: item.object.data.length,
        read: pull.once(item.object.data)
      })
    }
  }),
  toPull(process.stdout, function (err) {
    if (err)
      throw err
    process.disconnect()
  })
)
