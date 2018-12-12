require('colors');
var path = require('path');
var fs = require('fs');
var _url = require('url');
var webpack = require('webpack');
var Express =  require('express');
var webpackDevMiddleware = require('webpack-dev-middleware');

var webpackConfig = require('./dev.conf.js');
const devConfig = require('../bin/define.js').webpackConfig.dev
const dllmap = require('../dll-map.json')

const ORIGIN = 'https://online.yunshanmeicai.com';
var serverConfig = {
  PORT: 7777,
  ORIGIN,
  MOCK: true,
  HOT_REPLACE: false,
  WEIXIN_JSSDK_DEBUG: false,
  REDIRECT_RULES: {
    html: {
      "/$": `${ORIGIN}/entry/index`,
      "/entry/index(.*)": `${ORIGIN}/entry/index`,
      '/preview/index(.*)': `${ORIGIN}/preview/index`,
      '/mapp/(\.+)': `${ORIGIN}/mapp/$1`,
      '/store/(.*)': `${ORIGIN}/entry/index`,
      '/page/(.*)': `${ORIGIN}/entry/index`
    },
    api: {
      "/mall_trade/api/(.*)$": `${ORIGIN}/mall_trade/api/$1`,
      "/mall/api/(.*)$": `${ORIGIN}/mall/api/$1`,
      "/fi_invoice/api/(.*)$": `${ORIGIN}/fi_invoice/api/$1`
    }
  }
};

// 读取server配置文件
// const configPath = path.resolve('webpack/server.conf.js');
// var serverConfig = fs.readFileSync(configPath, "utf8");
// serverConfig = eval(`(${serverConfig})()`);

// 性能优化，去掉htmlWebpackPlugin
let removedPlugins = webpackConfig.plugins.filter(plugin => plugin.constructor.name == 'HtmlWebpackPlugin');
removedPlugins.forEach(rmPlugin => {
  let index = webpackConfig.plugins.findIndex(plugin => plugin == rmPlugin);
  webpackConfig.plugins.splice(index, 1);
});

let LOCAL_INDEX = `http://local.yunshanmeicai.com:${serverConfig.PORT}`;
if(serverConfig.HOT_REPLACE) {
  Object.keys(webpackConfig.entry).forEach((file) => {
    // 具体文件
    if(typeof webpackConfig.entry[file] === 'string') {
      webpackConfig.entry[file] = [
        path.resolve(__dirname, '../node_modules/webpack-hot-middleware/client'),
        webpackConfig.entry[file]
      ];
    }
  });
  webpackConfig.plugins.push(new webpack.HotModuleReplacementPlugin());
}

// chunk使用本地的
webpackConfig.output.publicPath = LOCAL_INDEX+ webpackConfig.output.publicPath;

// 初始化webpack
const compiler = webpack(webpackConfig);
const webpackDevMiddlewareInstance = webpackDevMiddleware(compiler, {
  contentBase: 'src',
  quiet: false,
  noInfo: false,
  hot: true,
  inline: true,
  lazy: false,
  publicPath: (webpackConfig[0] || webpackConfig).output.publicPath,
  headers: { 'Access-Control-Allow-Origin': '*' },
  // https://webpack.js.org/configuration/stats/#stats
  stats: { colors: true, cached: false, chunkModules: false, chunks: false }
});

const app = new Express();
app.use(webpackDevMiddlewareInstance);
if(serverConfig.HOT_REPLACE) {
  app.use(require('webpack-hot-middleware')(compiler));
}

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

// 特殊路由处理
app.use(async (req, res, next) => {
  let transmitRes = async function() {
    // 记录cookie
    let setCookies = [], jar = _req.jar();
    req.headers.cookie && req.headers.cookie.split(';').forEach(function(s) {
      jar.setCookie(_req.cookie(s), `https://yunshanmeicai.com`);
    });

    let res2, location = '';
    // account/login
    res2 = await request({url: `${serverConfig.ORIGIN}${req.url}`, jar: jar});
    setCookies = setCookies.concat(res2.headers["set-cookie"] || []);

    res.statusCode = res2.statusCode;
    res.setHeader('location', res2.headers.location);
    res.setHeader('set-cookie', setCookies);
    res.end();

    return;
  };
  const envs = [
      {key: 'TEST', name: 'wxtest'},
      {key: 'STAGE', name: 'test'},
      {key: 'ONLINE', name: 'online'}];
  let fetchServerConfig = async function() {
    let hostname = _url.parse(serverConfig.ORIGIN).host.split('.')[0];
    let json = {
      envs,
      envKey: envs.find( env => {
        return hostname === env.name;
      }).key,
      mock: serverConfig.MOCK
    };

    res.write(JSON.stringify(json));
    res.end();
  };
  let setServerConfig = async function() {
    let {envKey, mock} = req.query;
    let currEnv = envs.find(env => env.key === envKey);

    if(currEnv) {
      let hostname = _url.parse(serverConfig.ORIGIN).host.split('.')[0];
      let ORIGIN = serverConfig.ORIGIN.replace(hostname, currEnv.name);
      Object.values(serverConfig.REDIRECT_RULES).forEach(rule => {
        Object.keys(rule).forEach(key => {
          rule[key] = rule[key].replace(serverConfig.ORIGIN, ORIGIN);
        });
      });
      serverConfig.ORIGIN = ORIGIN;
    }
    if(mock !== undefined) {
      serverConfig.MOCK = mock === 'true'? true: false;
    }
    res.write(JSON.stringify({res: 'ok'}));
    res.end();
    console.log(`${'配置修改成功'.green}  ${serverConfig.ORIGIN}`);
  };
  let getServiceLineConfig = async function() {
    let result = {};
    const file = path.resolve(process.cwd(), 'service-line-config.json');
    if(fs.existsSync(file)) {

      try {
        let json = fs.readFileSync(file, 'utf8');
        json = JSON.parse(json);
        result = { "ret": 1, data: json };
      } catch(e) {
        result = {"ret": 0, "error": {"code": 00001, "msg": "json文件解析失败"}}
      }

    } else {
      result = {"ret": 0, "error": {"code": 00001, "msg": "配置文件不存在"}}
    }
    res.writeHead(200, {'content-type': 'application/json;charset=utf8'});
    res.write(JSON.stringify(result));
    res.end();
  };
  let routeMap = {
    // 对 登入/登出 进行处理，有302跳转
    '/account/logout': transmitRes,
    '/account/login': transmitRes,
    '/fetchServerConfig': fetchServerConfig,
    '/setServerConfig': setServerConfig,
    '/mall/api/notice/getServiceLineConfig': getServiceLineConfig // 本地业务线配置
  };
  let handler = routeMap[req.path];
  if(!handler) {
    next();
    return;
  }

  await handler();

  return;
});

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

  // 微信由于权限验证会跳转，把浏览器置为chrome
  if( !serverConfig.WEIXIN_JSSDK_DEBUG &&
      req.headers &&
      req.headers['user-agent'] &&
      req.headers['user-agent'].includes('MicroMessenger')) {
    req.headers["user-agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/62.0.3202.94 Safari/537.36";
  }
  // 门店cookie处理
  let weixin_ticket = req.headers.cookie &&
    req.headers.cookie.match(/pay_weixin_ticket=([^;]+);/);
  if(weixin_ticket) {
    req.headers.cookie += `; weixin_ticket=${weixin_ticket[1]};`;
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

    // 拦截html，修改js与css路径 为了让手机也能访问到不能设置为localhost
    var html = proxyRes.body.replace(/https:\/\/img-oss.(stage.)?yunshanmeicai.com\/weixin\/mall\/cdn\/public\/(js|css)\/([\w]+).\w+.min.(js|css)/g, function(url, stage, dir, name, ext) {
      return `${LOCAL_INDEX}${devConfig.publicPath}${dir}/${name}.${ext}`;
    });

    //dll替换为最新
    html = html.replace(/vendor.dll.\w+.js/g, function() {
      return dllmap.vendor.js;
    });

    // jsweixin与ticker处理
    html = html.replace(/src=\"\/\/(.+\.js)\"/g, function(match, url) {
      return `src="https://${url}"`;
    });

    // 后端会清空当前cookie，阻止这种行为
    proxyRes.headers['set-cookie'] = (proxyRes.headers['set-cookie'] || []).filter(cookie => {
      return !cookie.includes('deleted') && !cookie.includes('=0;');
    });

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

  // 微信 需要验证权限 local.yunshanmeicai.com域名通不过验证
  // if(proxyRes.headers.location && proxyRes.headers.location.includes('open.weixin.qq.com')) {
  //   proxyRes.headers.location =
  //     proxyRes.headers.location.replace(/redirect_uri=([^&]+)/,
  //       `redirect_uri=${encodeURIComponent(INDEX)}`);
  //   res.writeHead(302, proxyRes.headers);
  //   res.end();
  // }

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
// websocket转发
// server.on('upgrade', function (req, socket, head) {
//   httpProxy.ws(req, socket, head, {
//     target: 'ws://smarthotel.beta.qunar.com',
//     changeOrigin: true
//   });
// });

// 打包结束给出提示
webpackDevMiddlewareInstance.waitUntilValid(() => {
  let PORT = serverConfig.PORT;
  server.listen(PORT, (err) => {
    if (err) {
      console.error(err);
    } else {
      console.log(`\n ==> 🚧  ${'Server'.bold} Listening on port ${(''+PORT).red}`);
      console.log(`please access ${('http://local.yunshanmeicai.com:'+PORT).bold}\n`);
    }
  });
});

// 配置变化更新
// fs.watchFile(configPath, function(curr, prev) {
//   var newServerConfig = fs.readFileSync(configPath, "utf8");
//   newServerConfig = eval(`(${newServerConfig})()`);

//   let existError = false;
//   ['PORT', 'HOT_REPLACE'].forEach(name => {
//     if(serverConfig[name] != newServerConfig[name]) {
//       existError = true;
//       console.log(`参数 ${name.red} 不支持动态修改`);
//     }
//   });

//   serverConfig = newServerConfig;

//   if(!existError) {
//     console.log(`${'配置修改成功'.green}  ${serverConfig.ORIGIN}`);
//   }

//   // 额外的更新步骤
//   _req.defaults({
//     headers: {
//       "Referer": `${serverConfig.ORIGIN}/entry/index`
//     }
//   });
//   LOCAL_INDEX = `http://local.yunshanmeicai.com:${serverConfig.PORT}`;
// });

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