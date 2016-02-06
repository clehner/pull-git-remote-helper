#!/usr/bin/env node

var toPull = require('stream-to-pull-stream')
var pull = require('pull-stream')

process.on('uncaughtException', function (err) {
  if (err.stack)
    err = {stack: err.stack, message: err.message}
  process.send({error: err})
  process.exit(1)
})

pull(
  toPull(process.stdin),
  require('../')({
    prefix: 'foo',
    objectSink: function (readObject) {
      readObject(null, function next(end, type, read) {
        if (end === true) return
        if (end) throw end
        pull(
          read,
          pull.collect(function (err, bufs) {
            if (err) throw err
            var data = Buffer.concat(bufs).toString('ascii')
            process.send({object: {type: type, data: data}})
            readObject(null, next)
          })
        )
      })
    },
    refSink: pull.drain(function (ref) {
      process.send({ref: ref})
    }),
  }),
  toPull(process.stdout, function (err) {
    if (err)
      throw err
    process.disconnect()
  })
)
