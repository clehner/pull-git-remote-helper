#!/usr/bin/env node

var toPull = require('stream-to-pull-stream')
var pull = require('pull-stream')

pull(
  toPull(process.stdin),
  require('../')({
    prefix: 'foo',
    objectSink: pull.drain(function (obj) {
      console.error('obj', obj)
    })
  }),
  toPull(process.stdout, function (err) {
    if (err)
      throw err
  })
)
