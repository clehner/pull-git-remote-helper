var crypto = require('crypto')
var pull = require('pull-stream')

exports.createHash = function (type) {
  var hash = crypto.createHash(type)
  var hasher = pull.through(hash.update.bind(hash))
  hasher.hash = hash
  hasher.digest = hash.digest.bind(hash)
  return hasher
}

exports.createGitObjectHash = function (objectType, objectLength) {
  var hasher = exports.createHash('sha1')
  hasher.hash.update(objectType + ' ' + objectLength + '\0')
  return hasher
}
