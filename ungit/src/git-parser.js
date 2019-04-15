'use strict';

var moment = require('moment');
var fs = require('fs');
var path = require('path');
var fileType = require('./utils/file-type.js');
var _ = require('lodash');

exports.parseGitStatus = function (text, args) {
  var lines = text.split('\n');
  var files = {};
  // skipping first line...
  lines.slice(1).forEach(function (line) {
    if (line == '') return;
    var status = line.slice(0, 2);
    var filename = line.slice(3).trim().replace(/^"(.*)"$/, '$1'); // may contain old and renamed file name.
    var finalFilename = status[0] == 'R' ? filename.slice(filename.indexOf('>') + 2) : filename;
    files[finalFilename] = {
      displayName: filename,
      staged: status[0] == 'A' || status[0] == 'M',
      removed: status[0] == 'D' || status[1] == 'D',
      isNew: (status[0] == '?' || status[0] == 'A') && !(status[0] == 'D' || status[1] == 'D'),
      conflict: status[0] == 'A' && status[1] == 'A' || status[0] == 'U' || status[1] == 'U',
      renamed: status[0] == 'R',
      type: fileType(finalFilename)
    };
  });

  return {
    isMoreToLoad: false,
    branch: lines[0].split(' ').pop(),
    inited: true,
    files: files
  };
};

exports.parseGitStatusNumstat = function (text) {
  var result = {};
  text.split('\n').forEach(function (line) {
    if (line == '') return;
    var parts = line.split('\t');
    result[parts[2]] = {
      additions: parts[0],
      deletions: parts[1]
    };
  });
  return result;
};

var authorRegexp = /([^<]+)<([^>]+)>/;
var gitLogHeaders = {
  'Author': function Author(currentCommmit, author) {
    var capture = authorRegexp.exec(author);
    if (capture) {
      currentCommmit.authorName = capture[1].trim();
      currentCommmit.authorEmail = capture[2].trim();
    } else {
      currentCommmit.authorName = author;
    }
  },
  'Commit': function Commit(currentCommmit, author) {
    var capture = authorRegexp.exec(author);
    if (capture) {
      currentCommmit.committerName = capture[1].trim();
      currentCommmit.committerEmail = capture[2].trim();
    } else {
      currentCommmit.committerName = author;
    }
  },
  'AuthorDate': function AuthorDate(currentCommmit, date) {
    currentCommmit.authorDate = date;
  },
  'CommitDate': function CommitDate(currentCommmit, date) {
    currentCommmit.commitDate = date;
  },
  'Reflog': function Reflog(currentCommmit, data) {
    currentCommmit.reflogId = /\{(.*?)\}/.exec(data)[1];
    currentCommmit.reflogName = data.substring(0, data.indexOf(' ')).replace("refs/", "");
    var author = data.substring(data.indexOf('(') + 1, data.length - 1);
    var capture = authorRegexp.exec(author);
    if (capture) {
      currentCommmit.reflogAuthorName = capture[1].trim();
      currentCommmit.reflogAuthorEmail = capture[2].trim();
    } else {
      currentCommmit.reflogAuthorName = author;
    }
  },
  'gpg': function gpg(currentCommit, data) {
    if (data.startsWith('Signature made')) {
      // extract sign date
      currentCommit.signatureDate = data.slice('Signature made '.length);
    } else if (data.indexOf('Good signature from') > -1) {
      // fully verified.
      currentCommit.signatureMade = data.slice('Good signature from '.length).replace('[ultimate]', '').trim();
    } else if (data.indexOf('Can\'t check signature') > -1) {
      // pgp signature attempt is made but failed to verify
      delete currentCommit.signatureDate;
    }
  }
};
exports.parseGitLog = function (data) {
  var commits = [];
  var currentCommmit = void 0;
  var parseCommitLine = function parseCommitLine(row) {
    if (!row.trim()) return;
    currentCommmit = { refs: [], fileLineDiffs: [] };
    var refStartIndex = row.indexOf('(');
    var sha1s = row.substring(0, refStartIndex < 0 ? row.length : refStartIndex).split(' ').slice(1).filter(function (sha1) {
      return sha1 && sha1.length;
    });
    currentCommmit.sha1 = sha1s[0];
    currentCommmit.parents = sha1s.slice(1);
    if (refStartIndex > 0) {
      var refs = row.substring(refStartIndex + 1, row.length - 1);
      currentCommmit.refs = refs.split(/ -> |, /g);
    }
    currentCommmit.isHead = !!_.find(currentCommmit.refs, function (item) {
      return item.trim() === 'HEAD';
    });
    commits.isHeadExist = commits.isHeadExist || currentCommmit.isHead;
    commits.push(currentCommmit);
    parser = parseHeaderLine;
  };
  var parseHeaderLine = function parseHeaderLine(row) {
    if (row.trim() == '') {
      parser = parseCommitMessage;
    } else {
      for (var key in gitLogHeaders) {
        if (row.indexOf(key + ': ') == 0) {
          gitLogHeaders[key](currentCommmit, row.slice((key + ': ').length).trim());
          return;
        }
      }
    }
  };
  var parseCommitMessage = function parseCommitMessage(row, index) {
    if (/[\d-]+\t[\d-]+\t.+/g.test(rows[index + 1])) {
      parser = parseFileChanges;
      return;
    }
    if (rows[index + 1] && rows[index + 1].indexOf('commit ') == 0) {
      parser = parseCommitLine;
      return;
    }
    if (currentCommmit.message) currentCommmit.message += '\n';else currentCommmit.message = '';
    currentCommmit.message += row.trim();
  };
  var parseFileChanges = function parseFileChanges(row, index) {
    if (rows.length === index + 1 || rows[index + 1] && rows[index + 1].indexOf('commit ') === 0) {
      var total = [0, 0, 'Total'];
      for (var n = 0; n < currentCommmit.fileLineDiffs.length; n++) {
        var fileLineDiff = currentCommmit.fileLineDiffs[n];
        if (!isNaN(parseInt(fileLineDiff[0], 10))) {
          total[0] += fileLineDiff[0] = parseInt(fileLineDiff[0], 10);
        }
        if (!isNaN(parseInt(fileLineDiff[1], 10))) {
          total[1] += fileLineDiff[1] = parseInt(fileLineDiff[1], 10);
        }
      }
      currentCommmit.fileLineDiffs.splice(0, 0, total);
      parser = parseCommitLine;
      return;
    }
    var splitted = row.split('\t');
    splitted.push(fileType(splitted[2]));
    currentCommmit.fileLineDiffs.push(splitted);
  };
  var parser = parseCommitLine;
  var rows = data.split('\n');
  rows.forEach(function (row, index) {
    parser(row, index);
  });

  commits.forEach(function (commit) {
    commit.message = typeof commit.message === 'string' ? commit.message.trim() : '';
  });
  return commits;
};

exports.parseGitConfig = function (text) {
  var conf = {};
  text.split('\n').forEach(function (row) {
    var ss = row.split('=');
    conf[ss[0]] = ss[1];
  });
  return conf;
};

exports.parseGitBranches = function (text) {
  var branches = [];
  text.split('\n').forEach(function (row) {
    if (row.trim() == '') return;
    var branch = { name: row.slice(2) };
    if (row[0] == '*') branch.current = true;
    branches.push(branch);
  });
  return branches;
};

exports.parseGitTags = function (text) {
  return text.split('\n').filter(function (tag) {
    return tag != '';
  });
};

exports.parseGitRemotes = function (text) {
  return text.split('\n').filter(function (remote) {
    return remote != '';
  });
};

exports.parseGitLsRemote = function (text) {
  return text.split('\n').filter(function (item) {
    return item && item.indexOf('From ') != 0;
  }).map(function (line) {
    var sha1 = line.slice(0, 40);
    var name = line.slice(41).trim();
    return { sha1: sha1, name: name };
  });
};

exports.parseGitStashShow = function (text) {
  var lines = text.split('\n').filter(function (item) {
    return item;
  });
  return lines.slice(0, lines.length - 1).map(function (line) {
    return { filename: line.substring(0, line.indexOf('|')).trim() };
  });
};

exports.parseGitSubmodule = function (text, args) {
  if (!text) {
    return {};
  }

  var submodule = void 0;
  var submodules = [];

  text.trim().split('\n').filter(function (line) {
    return line;
  }).forEach(function (line) {
    if (line.indexOf("[submodule") === 0) {
      submodule = { name: line.match(/"(.*?)"/)[1] };
      submodules.push(submodule);
    } else {
      var parts = line.split("=");
      var key = parts[0].trim();
      var value = parts.slice(1).join("=").trim();

      if (key == "path") {
        value = path.normalize(value);
      } else if (key == "url") {
        // keep a reference to the raw url
        var url = submodule.rawUrl = value;

        // When a repo is checkout with ssh or git instead of an url
        if (url.indexOf('http') != 0) {
          if (url.indexOf('git:') == 0) {
            // git
            url = 'http' + url.substr(url.indexOf(':'));
          } else {
            // ssh
            url = 'http://' + url.substr(url.indexOf('@') + 1).replace(':', '/');
          }
        }

        value = url;
      }

      submodule[key] = value;
    }
  });

  var sorted_submodules = submodules.sort(function (a, b) {
    return a.name.localeCompare(b.name);
  });

  return sorted_submodules;
};

var updatePatchHeader = function updatePatchHeader(result, lastHeaderIndex, ignoredDiffCountTotal, ignoredDiffCountCurrent) {
  var splitedHeader = result[lastHeaderIndex].split(' ');
  var start = splitedHeader[1].split(','); // start of block
  var end = splitedHeader[2].split(','); // end of block
  var startLeft = Math.abs(start[0]);
  var startRight = Math.abs(start[1]);
  var endLeft = end[0];
  var endRight = end[1];

  splitedHeader[1] = '-' + (startLeft - ignoredDiffCountTotal) + ',' + startRight;
  splitedHeader[2] = '+' + (endLeft - ignoredDiffCountTotal) + ',' + (endRight - ignoredDiffCountCurrent);

  var allSpace = true;
  for (var i = lastHeaderIndex + 1; i < result.length; i++) {
    if (result[i][0] != ' ') {
      allSpace = false;
      break;
    }
  }
  if (allSpace) result.splice(lastHeaderIndex, result.length - lastHeaderIndex);else result[lastHeaderIndex] = splitedHeader.join(' ');
};

exports.parsePatchDiffResult = function (patchLineList, text) {
  if (!text) return null;

  var lines = text.trim().split('\n');
  var result = [];
  var ignoredDiffCountTotal = 0;
  var ignoredDiffCountCurrent = 0;
  var headerIndex = null;
  var lastHeaderIndex = -1;
  var n = 0;
  var selectedLines = 0;

  // first add all lines until diff block header is found
  while (!/@@ -[0-9]+,[0-9]+ \+[0-9]+,[0-9]+ @@/.test(lines[n])) {
    result.push(lines[n]);
    n++;
  }

  // per rest of the lines
  while (n < lines.length) {
    var line = lines[n];

    if (/^[\-\+]/.test(line)) {
      // Modified line
      if (patchLineList.shift()) {
        selectedLines++;
        // diff is selected to be committed
        result.push(line);
      } else if (line[0] === '+') {
        // added line diff is selected to be ignored
        ignoredDiffCountCurrent++;
      } else {
        // lines[0] === '-'
        // deleted line diff is selected to be ignored
        ignoredDiffCountCurrent--;
        result.push(' ' + line.slice(1));
      }
    } else {
      // none modified line or diff block header
      if (/@@ -[0-9]+,[0-9]+ \+[0-9]+,[0-9]+ @@/.test(line)) {
        // update previous header to match line numbers
        if (lastHeaderIndex > -1) {
          updatePatchHeader(result, lastHeaderIndex, ignoredDiffCountTotal, ignoredDiffCountCurrent);
        }
        // diff block header
        ignoredDiffCountTotal += ignoredDiffCountCurrent;
        ignoredDiffCountCurrent = 0;
        lastHeaderIndex = result.length;
      }
      result.push(line);
    }
    n++;
  }

  // We don't want to leave out last diff block header...
  updatePatchHeader(result, lastHeaderIndex, ignoredDiffCountTotal, ignoredDiffCountCurrent);

  if (selectedLines > 0) {
    return result.join('\n');
  } else {
    return null;
  }
};
