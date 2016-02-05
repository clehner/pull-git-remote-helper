var spawn = require('child_process').spawn
var tape = require('tape')
var path = require('path')
var mktemp = require('mktemp')
var rimraf = require('rimraf')
var fs = require('fs')

var env = Object.create(process.env)
env.PATH = __dirname + ':' + env.PATH
var remote = 'test.js://foo'

var tmpDir = mktemp.createDirSync(path.join(require('os').tmpdir(), 'XXXXXXX'))

function git() {
  var args = [].slice.call(arguments)
  var cb = args.pop()
  spawn('git', args, {
    env: env,
    cwd: tmpDir,
    stdio: ['ignore', process.stderr, process.stderr]
  }).on('close', cb)
}

tape('init repo', function (t) {
  git('init', function (code) {
    t.equals(code, 0, 'inited')
    t.end()
  })
})

tape('make a commit and push', function (t) {
  var filename = path.join(tmpDir, 'blah.txt')
  fs.writeFile(filename, 'i am a file', function (err) {
    t.error(err, 'wrote a file')
    git('add', filename, function (code) {
      t.equals(code, 0, 'added file')
      git('commit', '-mInitial commit', function (code) {
        t.equals(code, 0, 'made initial commit')
        git('push', '-vv', remote, 'master', function (code) {
          t.equals(code, 0, 'pushed')
          t.end()
        })
      })
    })
  })
})

tape.onFinish(function () {
  if (tmpDir)
    rimraf.sync(tmpDir)
})
