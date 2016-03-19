#!/usr/bin/env node

var toPull = require('stream-to-pull-stream')
var pull = require('pull-stream')
var createGitHash = require('pull-hash/ext/git')
var multicb = require('multicb')

process.on('uncaughtException', function (err) {
  if (err.stack)
    err = {stack: err.stack, message: err.message}
  process.send({error: err})
  process.exit(1)
})

pull(
  toPull(process.stdin),
  require('../../')({
    refs: pull.empty,
    symrefs: pull.empty,
    hasObject: function (hash, cb) { cb(null, false) },
    getObject: function (hash, cb) { cb(new Error('No objects here')) },
    update: function (readRefs, readObjects) {
      pull(
        readRefs,
        pull.drain(function (update) {
          process.send({update: update})
        }, function (err) {
          if (err) throw err
        })
      )
      readObjects(null, function next(end, object) {
        if (end === true) return
        if (end) throw end
        var done = multicb({ pluck: 1, spread: true })
        pull(
          object.read,
          createGitHash(object, done()),
          pull.collect(done())
        )
        done(function (err, id, bufs) {
          if (err) throw err
          var buf = Buffer.concat(bufs, object.length)
          process.send({object: {
            type: object.type,
            data: buf.toString('ascii'),
            length: object.length,
            hash: id
          }})
          readObjects(null, next)
        })
      })
    }
  }),
  toPull(process.stdout, function (err) {
    if (err)
      throw err
    process.disconnect()
  })
)
