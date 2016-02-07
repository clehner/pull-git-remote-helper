#!/usr/bin/env node

var toPull = require('stream-to-pull-stream')
var pull = require('pull-stream')

process.on('uncaughtException', function (err) {
  if (err.stack)
    err = {stack: err.stack, message: err.message}
  process.send({error: err})
  process.exit(1)
})

var objects = {}

var ref = {value: 'edb5b50e8019797925820007d318870f8c346726'}
var refs = {
  'refs/heads/master': ref,
  HEAD: ref
}

function refsSource() {
  console.error('sending refs', refs)
  var arr = []
  for (var name in refs)
    arr.push({
      name: name,
      value: refs[name].value,
      attrs: refs[name].attrs
    })
  return pull.values(arr)
}

pull(
  toPull(process.stdin),
  require('../')({
    prefix: 'foo',
    refSource: refsSource
  }),
  toPull(process.stdout, function (err) {
    if (err)
      throw err
    process.disconnect()
  })
)
