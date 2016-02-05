#!/usr/bin/env node

var toPull = require('stream-to-pull-stream')
var pull = require('pull-stream')

pull(
  toPull(process.stdin),
  require('../')({
    prefix: 'foo',
    objectSink: pull.drain(function (obj) {
      console.error('obj', obj)
    }),
    refSink: pull.drain(function (ref) {
      console.error('ref', ref)
    }),
  }),
  toPull(process.stdout, function (err) {
    if (err)
      throw err
  })
)
