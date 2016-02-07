var spawn = require('child_process').spawn
var tape = require('tape')
var path = require('path')
var mktemp = require('mktemp')
var rimraf = require('rimraf')
var fs = require('fs')
var repo = require('./repo')

var env = Object.create(process.env)
env.PATH = path.join(__dirname, 'remote') + ':' + env.PATH
env.GIT_AUTHOR_DATE = env.GIT_COMMITTER_DATE = repo.date
var user = repo.user
var remote = {
  empty: 'empty.js://',
  full: 'full.js://'
}

var tmpDir = mktemp.createDirSync(path.join(require('os').tmpdir(), 'XXXXXXX'))
tape.onFinish(function () {
  if (tmpDir)
    rimraf.sync(tmpDir)
})

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
  t.git('push', remote.empty, function (msg) {
  }, function (code) {
    t.equals(code, 0, 'pushed')
    t.end()
  })
})

tape('make a commit and push', function (t) {
  t.plan(8) // write, add, commit, push, ref, commit, tree, blob

  var file = repo.file
  var commitMessage = repo.commitMessage
  var commit = repo.commit
  var tree = repo.tree

  function obj(type, o) {
    return {
      type: type,
      data: o.data,
      length: o.data.length,
      hash: o.hash
    }
  }

  var objects = t.items(t.deepEquals, [
    [obj('commit', commit), 'got the commit'],
    [obj('tree', tree), 'got the tree'],
    [obj('blob', file), 'got the blob']
  ])

  var refs = t.items(t.deepEquals, [
    [{
      name: 'refs/heads/master',
      new: commit.hash,
      old: null
    }, 'got the ref']
  ])

  var filePath = path.join(tmpDir, file.name)
  fs.writeFile(filePath, file.data, function (err) {
    t.error(err, 'wrote a file')
    t.git('add', filePath, function (code) {
      t.equals(code, 0, 'added file')
      t.git('commit', '-m', commitMessage, function (code) {
        t.equals(code, 0, 'made initial commit')
        t.git('push', '-vv', remote.empty, 'master', function (msg) {
          if (msg.object)
            objects(msg.object)
          else if (msg.ref)
            refs(msg.ref)
          else
            t.notOk(msg, 'unexpected message')
        }, function (code) {
          t.equals(code, 0, 'pushed')
        })
      })
    })
  })
})

tape('fetch when already up-to-date', function (t) {
  t.git('fetch', '-vv', remote.full, function (msg) {
    t.notOk(msg, 'should not get a message here')
  }, function (code) {
    t.equals(code, 0, 'fetched')
    t.end()
  })
})

0 &&
tape('clone into new dir', function (t) {
  var dir = path.join(tmpDir, 'clonedir')
  t.plan(2)
  t.git('clone', '-vv', remote.full, dir, function (msg) {
    if (msg.want)
      t.deepEquals(msg.want, {
	type: 'want',
	hash: 'edb5b50e8019797925820007d318870f8c346726'
      }, 'got want')
    else
      t.notOk(msg, 'unexpected message')
  }, function (code) {
    t.equals(code, 0, 'cloned')
  })
})
