var buffered = require('pull-buffered')
var util = require('./util')

function rev(str) {
  return str === '0000000000000000000000000000000000000000' ? null : str
}

// from pull-stream/source.js
function abortCb(cb, abort, onAbort) {
  cb(abort)
  onAbort && onAbort(abort === true ? null: abort)
  return
}

function pktLineEncode(read) {
  var ended
  return function (end, cb) {
    if (ended) return cb(ended)
    read(end, function (end, data) {
      if (ended = end) {
        cb(end)
      } else {
        if (data)
          data += '\n'
        else
          data = ''
        var len = data ? data.length + 4 : 0
        var hexLen = ('000' + len.toString(16)).substr(-4)
        var pkt = hexLen + data
        // console.error('>', JSON.stringify(pkt))
        cb(end, pkt)
      }
    })
  }
}

function pktLineDecode(read, options) {
  var b = buffered(read)
  var readPrefix = b.chunks(4)
  var ended

  function readPackLine(abort, cb) {
    if (ended) return cb(ended)
    readPrefix(abort, function (end, buf) {
      if (ended = end) return cb(end)
      var len = parseInt(buf, 16)
      if (!len)
        return cb(null, new Buffer(''))
      b.chunks(len - 4)(null, function (end, buf) {
        if (ended = end) return cb(end)
        cb(end, buf)
      })
    })
  }

  function readPackLineStr(abort, cb) {
    if (ended) return cb(ended)
    readPackLine(abort, function (end, buf) {
      if (ended = end) return cb(end)
      // trim newline
      var len = buf.length
      if (buf[len - 1] == 0xa)
        len--
      var line = buf.toString('ascii', 0, len)
      cb(null, line)
    })
  }

  function readUpdate(abort, cb) {
    readPackLine(abort, function (end, line) {
      if (end) return cb(end)
      if (options.verbosity >= 2)
        console.error('line', line.toString('ascii'))
      if (!line.length) return cb(true)
      var args = util.split3(line.toString('ascii'))
      var args2 = util.split2(args[2], '\0')
      var caps = args2[1]
      if (caps && options.verbosity >= 2)
        console.error('update capabilities:', caps)
      cb(null, {
        old: rev(args[0]),
        new: rev(args[1]),
        name: args2[0]
      })
    })
  }

  function havesWants(onEnd) {
    return function readWant(abort, cb) {
      readPackLineStr(abort, function (end, line) {
        if (end) return abortCb(cb, end, onEnd)
        if (options.verbosity >= 2)
          console.error('line', line)
        if (!line.length || line == 'done')
          return abortCb(cb, true, onEnd)
        var args = util.split3(line)
        var caps = args[2]
        if (caps && options.verbosity >= 2)
          console.error('want capabilities:', caps)
        cb(null, {
          type: args[0],
          hash: args[1],
        })
      })
    }
  }

  b.pktLines = readPackLine
  b.updates = readUpdate
  b.wants = b.haves = havesWants

  return b
}

exports.encode = pktLineEncode
exports.decode = pktLineDecode
