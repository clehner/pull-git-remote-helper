#!/usr/bin/env node

var toPull = require('stream-to-pull-stream')
var pull = require('pull-stream')

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

pull(
  toPull(process.stdin),
  require('../')({
    prefix: 'foo',
    refSource: pull.values(refs),
    wantSink: pull.drain(function (want) {
      console.error('got want', want)
      process.send({want: want})
    }),
  }),
  toPull(process.stdout, function (err) {
    if (err)
      throw err
    process.disconnect()
  })
)
