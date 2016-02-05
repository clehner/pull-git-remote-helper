var spawn = require('child_process').spawn
var tape = require('tape')

var env = Object.create(process.env)
env.PATH = 'test:' + env.PATH 
var remote = 'test.js://foo'

function git(args, cb) {
  spawn('git', args, {
    env: env,
    stdio: ['ignore', 'ignore', 'inherit']
  }).on('close', cb)
}

tape('push to the remote', function (t) {
  git(['push', remote], function (code) {
    t.equals(code, 0, 'exit status')
    t.end()
  })
})
