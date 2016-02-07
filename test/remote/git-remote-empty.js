#!/usr/bin/env node

var toPull = require('stream-to-pull-stream')
var pull = require('pull-stream')
var util = require('../../util')

process.on('uncaughtException', function (err) {
  if (err.stack)
    err = {stack: err.stack, message: err.message}
  process.send({error: err})
  process.exit(1)
})

pull(
  toPull(process.stdin),
  require('../../')({
    objectSink: function (readObject) {
      readObject(null, function next(end, type, length, read) {
        if (end === true) return
        if (end) throw end
        var hasher = util.createGitObjectHash(type, length)
        pull(
          read,
          hasher,
          pull.collect(function (err, bufs) {
            if (err) throw err
            var buf = Buffer.concat(bufs, length)
            console.error('obj', type, length, JSON.stringify(buf.toString('ascii')))
            process.send({object: {
              type: type,
              data: buf.toString('ascii'),
              length: length,
              hash: hasher.digest('hex')
            }})
            readObject(null, next)
          })
        )
      })
    },
    refSink: pull.drain(function (ref) {
      process.send({ref: ref})
    })
  }),
  toPull(process.stdout, function (err) {
    if (err)
      throw err
    process.disconnect()
  })
)
