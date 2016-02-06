#!/usr/bin/env node

var toPull = require('stream-to-pull-stream')
var pull = require('pull-stream')

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
            console.error('object', type, bufs.length, data.length, JSON.stringify(data))
            readObject(null, next)
          })
        )
      })
    },
    refSink: pull.drain(function (ref) {
      console.error('ref', ref)
    }),
  }),
  toPull(process.stdout, function (err) {
    if (err)
      throw err
  })
)
