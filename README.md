# pull-git-remote-helper

Make a [git remote helper](http://git-scm.com/docs/git-remote-helpers) that
integrates with git's internal objects.

## Example

```js
#!/usr/bin/env node

var toPull = require('stream-to-pull-stream')
var pull = require('pull-stream')
var gitRemoteHelper = require('.')

var repo = {
  refs: pull.empty,
  hasObject: function (hash, cb) { cb(null, false) },
  getObject: function (hash, cb) { cb(null, null) },
  update: function (readUpdates, readObjects) {
    pull(
      readUpdates,
      pull.drain(function (update) {
        console.error('Updating ' + update.name + ' to ' + update.new)
      })
    )
    readObjects(null, function next(end, object) {
      if (end === true) return
      if (end) throw end
      pull(
        object.read,
        pull.collect(function (err, bufs) {
          if (err) throw err
          var buf = Buffer.concat(bufs, object.length)
          console.error('Got object', object, buf)
          readObjects(null, next)
        })
      )
    })
  }
}

pull(
  toPull(process.stdin),
  gitRemoteHelper(repo),
  toPull(process.stdout)
)

```

## API

#### `gitRemoteHelper(repo)`

  Create a through-stream for the stdio of a git-remote-helper

- `repo`: an [abstract-pull-git-repo][]-compliant git repo object.

[abstract-pull-git-repo]: https://github.com/clehner/abstract-pull-git-repo

## TODO

- Implement tree-walking to simplify `wantSink` and `getObjects`
- Handle shallow and unshallow fetch
- Test with a more complete server/remote implementation

## License

Fair License
