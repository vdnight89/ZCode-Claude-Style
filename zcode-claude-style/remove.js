'use strict';

const { remove } = require('./watch');

remove()
  .then(count => console.log('已卸载样式，检查主窗口数 ' + count))
  .catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
