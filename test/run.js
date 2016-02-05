var spawn = require('child_process').spawn
var tape = require('tape')
var path = require('path')
var mktemp = require('mktemp')
var rimraf = require('rimraf')

var env = Object.create(process.env)
env.PATH = __dirname + ':' + env.PATH
var remote = 'test.js://foo'

var tmpDir = mktemp.createDirSync(path.join(require('os').tmpdir(), 'XXXXXXX'))

function git(args, cb) {
  spawn('git', args, {
    env: env,
    cwd: tmpDir,
    stdio: ['ignore', process.stderr, process.stderr]
  }).on('close', cb)
}

tape('init repo', function (t) {
  git(['init'], function (code) {
    t.equals(code, 0, 'inited')
    t.end()
  })
})

tape('push with empty repo', function (t) {
  git(['push', remote], function (code) {
    t.equals(code, 0, 'pushed')
    t.end()
  })
})

tape.onFinish(function () {
  if (tmpDir)
    rimraf.sync(tmpDir)
})
