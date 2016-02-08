#!/usr/bin/env node

var toPull = require('stream-to-pull-stream')
var pull = require('pull-stream')
var util = require('../../lib/util')

process.on('uncaughtException', function (err) {
  if (err.stack)
    err = {stack: err.stack, message: err.message}
  process.send({error: err})
  process.exit(1)
})

pull(
  toPull(process.stdin),
  require('../../')({
    objectSink: function (read) {
      read(null, function next(end, object) {
        if (end === true) return
        if (end) throw end
        var hasher = util.createGitObjectHash(object.type, object.length)
        pull(
          object.read,
          hasher,
          pull.collect(function (err, bufs) {
            if (err) throw err
            var buf = Buffer.concat(bufs, object.length)
            process.send({object: {
              type: object.type,
              data: buf.toString('ascii'),
              length: object.length,
              hash: hasher.digest('hex')
            }})
            read(null, next)
          })
        )
      })
    },
    updateSink: pull.drain(function (update) {
      process.send({update: update})
    })
  }),
  toPull(process.stdout, function (err) {
    if (err)
      throw err
    process.disconnect()
  })
)
