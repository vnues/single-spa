import { reroute } from "./navigation/reroute.js";
import { formatErrorMessage } from "./applications/app-errors.js";
import { setUrlRerouteOnly } from "./navigation/navigation-events.js";
import { isInBrowser } from "./utils/runtime-environment.js";

let started = false;

export function start(opts) {
  started = true;
  if (opts && opts.urlRerouteOnly) {
    // * urlRerouteOnly:默认为false的布尔值。如果设置为true，对history.pushState()和history.replaceState()的调用将不会触发single-spa重路由，除非客户端路由被更改。在某些情况下，将此设置为true可以提高性能。
    setUrlRerouteOnly(opts.urlRerouteOnly);
  }
  // ! 只在浏览器环境中调用
  if (isInBrowser) {
    // * 核心方法 调度应用
    reroute();
  }
}

export function isStarted() {
  return started;
}

if (isInBrowser) {
  // * 5s过后还没启动应用，就会给予提示 为什么是5s? 因为这时候资源基本加载完毕
  setTimeout(() => {
    if (!started) {
      console.warn(
        // * 打印报错信息的技巧
        formatErrorMessage(
          1,
          __DEV__ &&
            `singleSpa.start() has not been called, 5000ms after single-spa was loaded. Before start() is called, apps can be declared and loaded, but not bootstrapped or mounted.`
        )
      );
    }
  }, 5000);
}
