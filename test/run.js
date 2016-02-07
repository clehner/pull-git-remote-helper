var spawn = require('child_process').spawn
var tape = require('tape')
var path = require('path')
var mktemp = require('mktemp')
var rimraf = require('rimraf')
var fs = require('fs')

function noop() {}

var env = Object.create(process.env)
env.PATH = __dirname + ':' + env.PATH
env.GIT_AUTHOR_DATE = env.GIT_COMMITTER_DATE = '1000000000 -0500'
var user = {
  name: 'test',
  email: 'test@localhost'
}
var userStr = user.name + ' <' + user.email + '>'
var remote = 'test.js://foo'

var tmpDir = mktemp.createDirSync(path.join(require('os').tmpdir(), 'XXXXXXX'))

function handleIpcMessage(t, cb) {
  return function (msg) {
    if (msg.error) {
      var err = new Error(msg.error.message)
      err.stack = msg.error.stack
      t.error(err)
    } else {
      cb(msg)
    }
  }
}

tape.Test.prototype.git = function () {
  var args = [].slice.call(arguments)
  var doneCb = args.pop()
  var msgCb = (typeof args[args.length-1] == 'function') && args.pop()
  return spawn('git', args, {
    env: env,
    cwd: tmpDir,
		stdio: ['ignore', 'inherit', 'inherit', 'ipc']
  })
  .on('close', doneCb)
  .on('message', handleIpcMessage(this, msgCb))
}

tape.Test.prototype.items = function (fn, items) {
  var i = 0
  return function (item) {
    fn.apply(this, [item].concat(items[i++]))
  }.bind(this)
}

tape('init repo', function (t) {
  t.git('init', function (code) {
    t.equals(code, 0, 'git init')
    t.git('config', 'user.name', user.name, function (code) {
      t.equals(code, 0, 'set user name')
      t.git('config', 'user.email', user.email, function (code) {
        t.equals(code, 0, 'set user email')
        t.end()
      })
    })
  })
})

tape('push with empty repo', function (t) {
  t.git('push', remote, function (msg) {
  }, function (code) {
    t.equals(code, 0, 'pushed')
    t.end()
  })
})

tape('make a commit and push', function (t) {
  var commitMessage = 'Initial commit'
  var fileName = 'blah.txt'
  var fileContents = 'i am a file'
  var fileHash = '68bd10497ea68e91fa85024d0a0b2fe54e212914'
  var treeHash = '75c54aa020772a916853987a03bff7079463a861'
  var commitHash = 'edb5b50e8019797925820007d318870f8c346726'
  var fileHashBuf = new Buffer(20)
  fileHashBuf.hexWrite(fileHash)

  var objects = t.items(t.deepEquals, [
    [{
      type: 'commit',
      data: 'tree ' + treeHash + '\nauthor ' + userStr + ' 1000000000 -0500\ncommitter ' + userStr + ' 1000000000 -0500\n\n' + commitMessage + '\n'
    }, 'got the commit'],
    [{
      type: 'tree',
      data: '100644 ' + fileName + '\0' + fileHashBuf.toString('ascii')
    }, 'got the tree'],
    [{
      type: 'blob', data: fileContents
    }, 'got the blob']
  ])

  var refs = t.items(t.deepEquals, [
    [{
      name: 'refs/heads/master',
      new: commitHash,
      old: null
    }, 'got the ref']
  ])

  var filePath = path.join(tmpDir, fileName)
  fs.writeFile(filePath, fileContents, function (err) {
    t.error(err, 'wrote a file')
    t.git('add', filePath, function (code) {
      t.equals(code, 0, 'added file')
      t.git('commit', '-m', commitMessage, function (code) {
        t.equals(code, 0, 'made initial commit')
        t.git('push', '-vv', remote, 'master', function (msg) {
          if (msg.object)
            objects(msg.object)
          else if (msg.ref)
            refs(msg.ref)
          else
            t.notOk(msg, 'unexpected message')
        }, function (code) {
          t.equals(code, 0, 'pushed')
          t.end()
        })
      })
    })
  })
})

/*
tape('fetch', function (t) {
  t.git('fetch', '-vv', remote, function (code) {
    t.equals(code, 0, 'fetched')
    t.end()
  })
})
*/

tape.onFinish(function () {
  if (tmpDir)
    rimraf.sync(tmpDir)
})
