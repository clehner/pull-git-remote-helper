function hexToStr(str) {
  var buf = new Buffer(str.length / 2)
  buf.hexWrite(str)
  return buf.toString('ascii')
}

var date = '1000000000 -0500'

var user = {
  name: 'test',
  email: 'test@localhost'
}
user.str = user.name + ' <' + user.email + '>'

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
    'author ' + user.str + ' ' + date,
    'committer ' + user.str + ' ' + date,
    '', commitMessage, ''
  ].join('\n')
}

exports.date = date
exports.user = user
exports.file = file
exports.tree = tree
exports.commitMessage = commitMessage
exports.commit = commit
