# pull-git-remote-helper

Make a [git remote helper](http://git-scm.com/docs/git-remote-helpers) that
integrates with git's internal objects.

## Example

```js
#!/usr/bin/env node

var toPull = require('stream-to-pull-stream')
var pull = require('pull-stream')
var gitRemoteHelper = require('.')

var options = {
  updateSink: pull.drain(function (update) {
    console.error('Updating ' + update.name + ' to ' + update.new)
  }),
  objectSink: function (read) {
    read(null, function next(end, object) {
      if (end === true) return
      if (end) throw end
      pull(
        object.read,
        pull.collect(function (err, bufs) {
          if (err) throw err
          var buf = Buffer.concat(bufs, object.length)
          console.error('Got object', object, buf)
          read(null, next)
        })
      )
    })
  }
}

pull(
  toPull(process.stdin),
  gitRemoteHelper(options),
  toPull(process.stdout)
)
```

## API

The streams in this module are [pull-streams](https://github.com/dominictarr/pull-stream).

- `gitRemoteHelper(options)`

  Create a through-stream for the stdio of a git-remote-helper

- `options.refsSource`

  Readable stream of refs that the remote has.

  Ref object are of the form `{name: name, value: hash}`

  - `ref.name`: a name like `"HEAD"` or `"refs/heads/master"`
  - `ref.value`: 20-character SHA1 hash of a commit

- `options.updateSink`

  Reader for updates received from the client during a `git push`.

  - `update.name`: the name of the ref, e.g. `"refs/heads/master"`
  - `update.old`: the previous rev (commit SHA1 hash) of the branch.
    May be null if the branch did not exist before.
  - `update.new`: the new rev of the branch. null to delete the ref.

- `options.objectSink`

  Reader for git objects received in a `git push`.

  - `object.type`: the type of the object, either
    `"tag"`, `"commit"`, `"tree"`, or `"blob"`
  - `object.length`: the size in bytes of the object
  - `object.read`: readable stream of the object's data. This has to be
      drained before `objectSink` can read the next object.

- `options.wantSink`

  Reader for wants received by client during a `git fetch`.

  - `want.type == "want"`: the client wants this object
  - `want.type == "shallow"`: the client *has* this object but it is shallow.
    TODO: put this somewhere else
  - `want.hash`: SHA1 hash of the object

- `options.hasObject`: `function (hash, cb(Boolean))`

  Query the remote if it has a specific git object. Used in `git fetch` to help
  the remote decide what objects to send to the client.

- `options.getObjects`: `function (id, cb(end, numObjects, readObject))`

  Get a stream of git objects to send to the client. These should include the
  objects passed from the client as wants in `wantSink`, and their history
  (ancestor commits and their objects), but don't have to go further back than
  the common ancestor object `id`.

  - `id`: hash of a common ancestor of objects that the client and the remote
    have.
  - `end`: read error or `true` if the stream is done
  - `numObjects`: number of objects that readObject will stream
  - `readObject`: readable stream of git objects

## TODO

- Implement tree-walking to simplify `wantSink` and `getObjects`
- Handle shallow and unshallow fetch
- Test with a more complete server/remote implementation

## License

Fair License
