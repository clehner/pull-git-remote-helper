#!/usr/bin/env node

var toPull = require('stream-to-pull-stream')
var pull = require('pull-stream')
var util = require('../util')

process.on('uncaughtException', function (err) {
  if (err.stack)
    err = {stack: err.stack, message: err.message}
  process.send({error: err})
  process.exit(1)
})

var objects = {}
var refs = {}

function refsSource() {
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
            var buf = Buffer.concat(bufs)
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
      refs[ref.name] = {value: ref.new}
      console.error('got ref', refs)
      process.send({ref: ref})
    }),
    refSource: function () {
      console.error('sending refs', refs)
      return refsSource()
    }
  }),
  toPull(process.stdout, function (err) {
    if (err)
      throw err
    process.disconnect()
  })
)
