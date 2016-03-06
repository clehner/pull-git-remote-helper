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
