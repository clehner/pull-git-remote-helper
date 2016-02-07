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
user.str = user.name + ' <' + user.email + '>'
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

function hexToStr(str) {
  var buf = new Buffer(str.length / 2)
  buf.hexWrite(str)
  return buf.toString('ascii')
}

tape('make a commit and push', function (t) {
  t.plan(8) // write, add, commit, push, ref, commit, tree, blob

  var file = {
    name: 'blah.txt',
    data: 'i am a file',
    hash: '68bd10497ea68e91fa85024d0a0b2fe54e212914'
  }

  var tree = {
    hash: '75c54aa020772a916853987a03bff7079463a861',
    data: '100644 ' + file.name + '\0' + hexToStr(file.hash)
  }

  var commitMessage = 'Initial commit'
  var commit = {
    hash: 'edb5b50e8019797925820007d318870f8c346726',
    data: ['tree ' + tree.hash,
      'author ' + user.str + ' 1000000000 -0500',
      'committer ' + user.str + ' 1000000000 -0500',
      '', commitMessage, ''
    ].join('\n')
  }

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
        t.git('push', '-vv', remote, 'master', function (msg) {
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
