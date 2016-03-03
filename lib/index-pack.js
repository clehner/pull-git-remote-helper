var pull = require('pull-stream')
var toPull = require('stream-to-pull-stream')
var cp = require('child_process')
var fs = require('fs')
var path = require('path')
var os = require('os')

module.exports = function (packFile, cb) {
  var name = Math.random().toString(36).substr(2)
  var indexFilename = path.join(os.tmpdir(), name + '.idx')
  var packFilename = path.join(os.tmpdir(), name + '.pack')

  var args = ['index-pack', '--stdin', '-o', indexFilename, packFilename]
  var child = cp.spawn('git', args, {
    stdio: ['pipe', 'pipe', 'inherit']
  })
  pull(packFile, toPull.sink(child.stdin))
  child.on('close', function (err) {
    if (err) return cb(err)
    fs.unlink(packFilename, function (err) {
      if (err) return cb(err)
      cb(null, toPull(fs.createReadStream(indexFilename), function (err) {
        if (err) return console.error(err)
      }))
    })
  })
}
