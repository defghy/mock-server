require('colors');
var path = require('path');
var fs = require('fs');
var _url = require('url');
var Express =  require('express');

const ORIGIN = 'https://treasure-box.test.yunshanmeicai.com';
var serverConfig = {
  PORT: 7777,
  ORIGIN,
  MOCK: true,
  REDIRECT_RULES: {
    html: {
      "/$": `${ORIGIN}/entry/index`,
      "/entry/index(.*)": `${ORIGIN}/entry/index`
    },
    api: {
      "/app/(.*)$": `${ORIGIN}/app/$1`
    }
  }
};

const app = new Express();

// 由于页面跳转，不再由server控制，需要模拟login来获取登陆成功后的cookie
var _req = require('request').defaults({
    gzip: true,
    followRedirect: false,
    timeout: 6000,
    method: 'GET',
    rejectUnauthorized: false, // 去掉https证书风险提示
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
      "Accept-Encoding": "gzip, deflate",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Cache-Control": "no-cache",
      "Referer": `${serverConfig.ORIGIN}/entry/index`
    }
});
// 封装request为promise
let request = function(opt) {
  opt.headers = Object.assign(opt.headers || {}, {
    Host: _url.parse(opt.url).host
  });
  return new Promise((resolve, reject) => {
    _req(opt, (err, res, body) => {
      if(err) {
          reject(err);
          return;
      }
      resolve(res);
    });
  });
};

// 转发html
var httpProxy = require('http-proxy');
var _zlib = require('zlib');
app.use(async (req, res, next) => {
  // 设置转发
  var rules = serverConfig.REDIRECT_RULES.html;
  var ruleName = Object.keys(rules).find(ruleName => {
    return ruleName === req.url || new RegExp(ruleName).test(req.url);
  });
  if(!ruleName) { // 未匹配上，继续
    next();
    return;
  }

  // 请求相关html
  var urlData = req.url.split('?');
  var path = urlData[0];
  var search = urlData[1];
  // 正则替换 && 组装search
  var url = rules[ruleName].replace('$1', new RegExp(ruleName).exec(path)[1] || '');
  url += search? `?${search}`: '';
  var proxyRes = await request({url: url, headers: req.headers});

  // chrome 正常返回html
  if(proxyRes.statusCode == 200) {

    res.writeHead(200, proxyRes.headers);
    res.write(_zlib.gzipSync(html)); // 重新压缩为gzip
    res.end();
    return;
  }
  // 错误处理
  if(proxyRes.statusCode<200 || proxyRes.statusCode>=400) {
    res.writeHead(proxyRes.statusCode, { 'Content-Type': 'text/html' });
    res.end(proxyRes.body);
  }
  // mapp有302转发的情况
  else {
    // charles转发时会有问题
    let location = proxyRes.headers.location;
    try {
      // 兼容charles的hash
      proxyRes.headers.location = location? decodeURIComponent(location): location;
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
    } catch(e) {
      // 普通页面访问
      proxyRes.headers.location = location;
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
    }

    res.end(proxyRes.body);
  }

});

// 转发api
var proxy = httpProxy.createProxyServer({
  secure: false // 去掉https证书风险提示
});
app.use(async (req, res, next) => {
  // 设置转发
  var rules = serverConfig.REDIRECT_RULES.api;
  var ruleNames = Object.keys(rules);
  var ruleName = ruleNames.find(ruleName => {
    return ruleName === req.url || new RegExp(ruleName).test(req.url);
  });

  if(!ruleName) {
    next();
    return;
  }


  var target = rules[ruleName];
  // 使用正则来匹配接口path
  target = target.replace('$1', new RegExp(ruleName).exec(req.url)[1] || '');
  target = _url.parse(target);

  // 使用mock读取本地数据
  if(serverConfig.MOCK) {
    try {
      // mock/mall/api/commodity/ssudetail.json
      let jsonFilePath = `mock${target.pathname}.json`;
      if(fs.existsSync(jsonFilePath)) {
        var json = fs.readFileSync(jsonFilePath, "utf8");
        json = new Function(`var a = ${json}; return a;`)();
        json = JSON.stringify(json);

        res.writeHead(200, {'content-type': 'application/json;charset=utf8'});
        res.write(json); // 重新压缩为gzip
        res.end();
        return;
      }
    } catch(e) {
      console.error(`json parse fail: ${e.message}`.red);
    }

  }

  // 使用http获取数据
  req.url = target.path;
  proxy.web(req, res, {
    target: `${target.protocol}//${target.host}`,
    changeOrigin: true
  }, function (e) {
    // 连接服务器错误
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end(e.toString());
  });

});

var server = require('http').createServer(app);
let PORT = serverConfig.PORT;
server.listen(PORT, (err) => {
  if (err) {
    console.error(err);
  } else {
    console.log(`\n ==> 🚧  ${'Server'.bold} Listening on port ${(''+PORT).red}`);
    console.log(`please access ${('http://local.yunshanmeicai.com:'+PORT).bold}\n`);
  }
});

// 报错退出，主推退出server结束端口占用
process.on('uncaughtException', (err) => {
  server && server.close();
});
process.on('SIGTERM', () => {
  server && server.close();

  //主进程退出, 其子node进程也随即退出
  setTimeout(() => {
      process.exit();
  }, 1000);
});