var buffered = require('pull-buffered')
var pull = require('pull-stream')
var toPull = require('stream-to-pull-stream')
var Inflate = require('pako/lib/inflate').Inflate
var createHash = require('./util').createHash
var cat = require('pull-cat')

exports.decode = decodePack
exports.encode = encodePack

var PACK_VERSION = 2

var objectTypes = [
  'none', 'commit', 'tree', 'blob',
  'tag', 'unused', 'ofs-delta', 'ref-delta'
]

function error(cb) {
  return function (err) {
    cb(err || true)
  }
}

function inflateBytes(read) {
  var inflate = new Inflate()
  var ended, dataOut

  inflate.onData = function (data) {
    dataOut = new Buffer(data)
    // console.error('inflated data', data.length)
  }

  inflate.onEnd = function (status) {
    ended = (status === 0) ? true : new Error(inflate.msg)
    // console.error('inflated end', status, ended)
  }

  return function (abort, cb) {
    if (ended) return cb(ended)
    read(abort, function next(end, data) {
      if (end === true) {
        end = null
        data = []
      }
      if (ended = end) return cb(end)
      if (data.length > 1) return cb(new Error('got more than one byte'))
      dataOut = null
      inflate.push(data, end === true)
      if (dataOut)
        cb(null, dataOut)
      else if (ended)
        cb(ended)
      else
        read(null, next)
    })
  }
}

function decodePack(onEnd, read) {
  if (read === undefined)
    return decodePack.bind(this, onEnd)

  var ended
  var numObjects = -1
  var checksum = createHash('sha1')
  var b = buffered(read)
  // TODO: optimize to pass through buffers to checksum
  var readByte = checksum(b.chunks(1))
  var readWord = checksum(b.chunks(4))
  var readChecksum = b.chunks(20)
  var expectChecksum = true
  var opts = {
    verbosity: 2
  }

  function readHeader(cb) {
    readWord(null, function (end, header) {
      if (ended = end) return cb(end)
      if (!header.equals(header, new Buffer('PACK')))
        read(new Error('Invalid packfile header'), error(cb))
      else
        readVersion(cb)
    })
  }

  function readVersion(cb) {
    readWord(null, function (end, word) {
      if (ended = end) return cb(end)
      var version = word.readUInt32BE()
      if (version < 2 || version > 3)
        read(new Error('Invalid packfile version ' + version), error(cb))
      else
        readNumObjects(cb)
    })
  }

  function readNumObjects(cb) {
    readWord(null, function (end, word) {
      if (ended = end) return cb(end)
      numObjects = word.readUInt32BE()
      if (opts.verbosity >= 1)
        console.error(numObjects + ' objects')
      readObject(null, cb)
    })
  }

  function readVarInt(cb) {
    var type, value, shift
    // https://codewords.recurse.com/images/three/varint.svg
    readByte(null, function (end, buf) {
      if (ended = end) return cb(end)
      var firstByte = buf[0]
      type = objectTypes[(firstByte >> 4) & 7]
      value = firstByte & 15
      // console.error('byte1', firstByte, firstByte.toString(2), value, value.toString(2))
      shift = 4
      checkByte(firstByte)
    })

    function checkByte(byte) {
      if (byte & 0x80)
        readByte(null, gotByte)
      else
        cb(null, type, value)
    }

    function gotByte(end, buf) {
      if (ended = end) return cb(end)
      var byte = buf[0]
      value += (byte & 0x7f) << shift
      shift += 7
      // console.error('byte', byte, byte.toString(2), value, value.toString(2))
      checkByte(byte)
    }
  }

  function getObject(cb) {
    readVarInt(function (end, type, length) {
      if (opts.verbosity >= 2)
        console.error('read var int', end, type, length)
      numObjects--
      if (end === true && expectChecksum)
        onEnd(new Error('Missing checksum'))
      if (ended = end) return cb(end)
      // TODO: verify that the inflated data is the correct length
      cb(null, type, length, inflateBytes(readByte))
    })
  }

  function readTrailer(cb) {
    // read the checksum before it updates to include the trailer
    var expected = checksum.digest()
    readChecksum(null, function (end, value) {
      cb(true)
      if (end === true && expectChecksum)
        onEnd(new Error('Missing checksum'))
      if (!value.equals(expected)) {
        onEnd(new Error('Checksum mismatch: ' +
          expected.hexSlice() + ' != ' + value.hexSlice()))
      } else {
        if (opts.verbosity >= 2)
          console.error('checksum ok', expected.hexSlice())
        onEnd(null)
      }
    })
  }

  function readObject(abort, cb) {
    if (ended) cb(ended)
    else if (abort) read(abort)
    else if (numObjects < 0) readHeader(cb)
    else if (numObjects > 0) getObject(cb)
    else if (expectChecksum) readTrailer(cb)
  }

  return readObject
}

function encodePack(numObjects, readObject) {
  var ended
  var header = new Buffer(12)
  header.write('PACK')
  header.writeUInt32BE(PACK_VERSION, 4)
  header.writeUInt32BE(numObjects, 8)
  var checksum = createHash('sha1')

  return pull.through(function (data) {
    console.error('> ' + data.length, data.toString())
  })(cat([
    checksum(cat([
      pull.once(header),
      function (abort, cb) {
        if (ended) return cb(ended)
        readObject(abort, function (end, type, length, read) {
          if (ended = end) return cb(end)
          console.error('TODO: encode object')
        })
      }
    ])),
    checksum.readDigest
  ]))
}
