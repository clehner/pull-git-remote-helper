var crypto = require('crypto')
var pull = require('pull-stream')

exports.createHash = function (type) {
  var hash = crypto.createHash(type)
  var hasher = pull.through(hash.update.bind(hash))
  var digest
  hasher.hash = hash
  hasher.digest = hash.digest.bind(hash)
  hasher.readDigest = function (abort, cb) {
    if (digest) cb(true)
    else cb(null, digest = hash.digest())
  }
  return hasher
}

exports.createGitObjectHash = function (objectType, objectLength) {
  var hasher = exports.createHash('sha1')
  hasher.hash.update(objectType + ' ' + objectLength + '\0')
  return hasher
}

exports.split2 = function (str, delim) {
  var i = str.indexOf(delim || ' ')
  return (i === -1) ? [str, ''] : [
    str.substr(0, i),
    str.substr(i + 1)
  ]
}

exports.split3 = function (str) {
  var args = exports.split2(str)
  return [args[0]].concat(exports.split2(args[1]))
}
