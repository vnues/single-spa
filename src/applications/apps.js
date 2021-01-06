import { ensureJQuerySupport } from "../jquery-support.js";
import {
  isActive,
  toName,
  NOT_LOADED,
  NOT_BOOTSTRAPPED,
  NOT_MOUNTED,
  MOUNTED,
  LOAD_ERROR,
  SKIP_BECAUSE_BROKEN,
  LOADING_SOURCE_CODE,
  shouldBeActive,
} from "./app.helpers.js";
import { reroute } from "../navigation/reroute.js";
import { find } from "../utils/find.js";
import { toUnmountPromise } from "../lifecycles/unmount.js";
import {
  toUnloadPromise,
  getAppUnloadInfo,
  addAppToUnload,
} from "../lifecycles/unload.js";
import { formatErrorMessage } from "./app-errors.js";
import { isInBrowser } from "../utils/runtime-environment.js";
import { assign } from "../utils/assign";

const apps = [];

export function getAppChanges() {
  const appsToUnload = [],
    appsToUnmount = [],
    appsToLoad = [],
    appsToMount = [];

  // We re-attempt to download applications in LOAD_ERROR after a timeout of 200 milliseconds
  const currentTime = new Date().getTime();

  apps.forEach((app) => {
    const appShouldBeActive =
      app.status !== SKIP_BECAUSE_BROKEN && shouldBeActive(app);

    switch (app.status) {
      case LOAD_ERROR:
        if (appShouldBeActive && currentTime - app.loadErrorTime >= 200) {
          appsToLoad.push(app);
        }
        break;
      case NOT_LOADED:
      case LOADING_SOURCE_CODE:
        if (appShouldBeActive) {
          appsToLoad.push(app);
        }
        break;
      case NOT_BOOTSTRAPPED:
      case NOT_MOUNTED:
        if (!appShouldBeActive && getAppUnloadInfo(toName(app))) {
          appsToUnload.push(app);
        } else if (appShouldBeActive) {
          appsToMount.push(app);
        }
        break;
      case MOUNTED:
        if (!appShouldBeActive) {
          appsToUnmount.push(app);
        }
        break;
      // all other statuses are ignored
    }
  });

  return { appsToUnload, appsToUnmount, appsToLoad, appsToMount };
}

// * 获取状态为Mounted的应用
export function getMountedApps() {
  return apps.filter(isActive).map(toName);
}

// * 根据appName获取app
export function getAppNames() {
  return apps.map(toName);
}

// used in devtools, not (currently) exposed as a single-spa API
// ? 废弃的api 不用理会
export function getRawAppData() {
  return [...apps];
}
// * 根据appName获取应用状态
export function getAppStatus(appName) {
  const app = find(apps, (app) => toName(app) === appName);
  return app ? app.status : null;
}

/**
 *
 * @param {*} appNameOrConfig app名称或者配置项
 * @param {*} appOrLoadApp  加载app资源的函数 返回值为Promise
 * @param {*} activeWhen 什么时候开始激活这个应用
 * @param {*} customProps 传递给子应用的 props 对象
 */
export function registerApplication(
  appNameOrConfig,
  appOrLoadApp,
  activeWhen,
  customProps
) {
  // * 筛选和过滤传递过来的配置项===>使它们合法化
  const registration = sanitizeArguments(
    appNameOrConfig,
    appOrLoadApp,
    activeWhen,
    customProps
  );

  if (getAppNames().indexOf(registration.name) !== -1)
    // * 重复注册
    throw Error(
      formatErrorMessage(
        21,
        __DEV__ &&
          `There is already an app registered with name ${registration.name}`,
        registration.name
      )
    );
  // * apps是全局数组变量 我们把所有注册的app应用都push进去，并初始化状态为NOT_LOADED
  apps.push(
    assign(
      {
        loadErrorTime: null,
        status: NOT_LOADED,
        parcels: {},
        devtools: {
          overlays: {
            options: {},
            selectors: [],
          },
        },
      },
      registration
    )
  );
  if (isInBrowser) {
    /**
     * 简单理解：如果页面中使用了jQuery，则给jQuery打patch
     * ! 因为JQuery是调用$.on来注册事件的而不是通过addEventListner
     * ! https://zh-hans.single-spa.js.org/docs/api/
     * ! https://learn.jquery.com/events/event-delegation/
     * jQuery使用 event delegation 所以 single-spa 必须给每个jQuery版本一个patch
     * ! 事件委托， 改写 $.on 绑定 hashchange、popstate 事件的功能，以便支持使用 window.$
     */

    ensureJQuerySupport();
    // ! 核心方法 其负责调控应用脚本加载、卸载，应用内容挂载、卸载的流程
    reroute();
  }
}

// * 在当前loaction,通过activeWhen函数检测是否要加载应用
export function checkActivityFunctions(location = window.location) {
  return apps.filter((app) => app.activeWhen(location)).map(toName);
}

/**
 * * 注销应用
 * unregisterApplication函数将unmount、unload和注销应用程序。一旦使用它不再被注册，应用程序将不再被装载。
 * ! 立即卸载 默认{waitForUnmount:false}
 */
export function unregisterApplication(appName) {
  if (apps.filter((app) => toName(app) === appName).length === 0) {
    throw Error(
      // ! 可以看到成熟的库处理错误信息都很优雅
      formatErrorMessage(
        25,
        __DEV__ &&
          `Cannot unregister application '${appName}' because no such application has been registered`,
        appName
      )
    );
  }
  // * unloadApplication函数做了这三步 unmount、unload和注销应用程序
  return unloadApplication(appName).then(() => {
    // * 核心一步就是在apps数组中去除
    const appIndex = apps.map(toName).indexOf(appName);
    apps.splice(appIndex, 1);
  });
}

/**
 * 当调用 unloadApplication 时，Single-spa执行以下步骤。
 * 在一个已经注册的应用上，调用 unload lifecyle 方法。
 * 将次应用的状态置为 NOT_LOADED
 * 触发路由重定向，在此期间single-spa可能会挂载刚刚卸载的应用程序。
 */
// ! 移除已注册的应用的目的是将其设置回 NOT_LOADED 状态，这意味着它将在下一次需要挂载时重新初始化。
// ! 它的主要使用场景是允许热加载所有已注册的应用，但是 unloadApplication 可以在您希望初始化应用时非常有用。
// ! 主要可能用于热重载 热重载： 文件改动后，以最小的代价改变被改变的区域。尽可能保留改动文件前的状态（修改js代码之后可以把页面输入的部分信息保留下来）
export function unloadApplication(appName, opts = { waitForUnmount: false }) {
  if (typeof appName !== "string") {
    throw Error(
      formatErrorMessage(
        26,
        __DEV__ && `unloadApplication requires a string 'appName'`
      )
    );
  }
  const app = find(apps, (App) => toName(App) === appName);
  if (!app) {
    throw Error(
      formatErrorMessage(
        27,
        __DEV__ &&
          `Could not unload application '${appName}' because no such application has been registered`,
        appName
      )
    );
  }
  // * 获取要unload的app的信息 是否存在在appsToUnload集合
  const appUnloadInfo = getAppUnloadInfo(toName(app
  console.log("appUnloadInfo", appUnloadInfo);
  if (opts && opts.waitForUnmount) {
    // * 属性的对象。当 `waitForUnmount` 是 `false`, single-spa 立刻移除特定应用，尽管它已经被挂载。 当它是true时, single-spa 会等待到它的状态不再是MOUNTED时才移除应用
    // We need to wait for unmount before unloading the app
    // * 如果存在appUnloadInfo
    if (appUnloadInfo) {
      // Someone else is already waiting for this, too
      // * 返回的是一个Promsie
      return appUnloadInfo.promise;
    } else {
      // We're the first ones wanting the app to be resolved.
      const promise = new Promise((resolve, reject) => {
        // * 将该unload的应用添加到appsToUnload集合
        addAppToUnload(app, () => promise, resolve, reject);
      });
      return promise;
    }
  } else {
    // * 如果立刻移除特定应用
    /* We should unmount the app, unload it, and remount it immediately.
     */
    let resultPromise;

    if (appUnloadInfo) {
      // Someone else is already waiting for this app to unload
      resultPromise = appUnloadInfo.promise;
      immediatelyUnloadApp(app, appUnloadInfo.resolve, appUnloadInfo.reject);
    } else {
      // We're the first ones wanting the app to be resolved.
      resultPromise = new Promise((resolve, reject) => {
        // * 传递resolve,reject可以理解为交出该Promise的控制权
        addAppToUnload(app, () => resultPromise, resolve, reject);
        immediatelyUnloadApp(app, resolve, reject);
      });
    }

    return resultPromise;
  }
}

// umount==>unload==>remount
function immediatelyUnloadApp(app, resolve, reject) {
  // * 调用umount生命周期函数进行卸载
  toUnmountPromise(app)
  // * 调用unload生命周期函数
    .then(toUnloadPromise)
    .then(() => {
      // 注意这里resolve 通知then注册微任务
      resolve();
      setTimeout(() => {
        // reroute, but the unload promise is done
        debugger
        // ! 这里由于宏任务低于上面微任务的优先级 所以apps是去除注册过后的 reroute, but the unload promise is done
        // ? 然后再执行reroute 好奇怪为啥要再执行一遍 ===> 因为unloadApplication是为热重载 此时app为NOT_LOADED状态
        // ! 但是我们单单只调用unloadApplication没有删除app，所以应该重新reroute然后挂载
        // ! 而unregisterApplication是删除了app  所以执行reroute跟不执行没什么区别
        console.log(apps)
        reroute();
      });
    })
    .catch(reject);
}

// * 校验registerApplication函数的参数
function validateRegisterWithArguments(
  name,
  appOrLoadApp,
  activeWhen,
  customProps
) {
  if (typeof name !== "string" || name.length === 0)
    throw Error(
      formatErrorMessage(
        20,
        __DEV__ &&
          `The 1st argument to registerApplication must be a non-empty string 'appName'`
      )
    );

  if (!appOrLoadApp)
    throw Error(
      formatErrorMessage(
        23,
        __DEV__ &&
          "The 2nd argument to registerApplication must be an application or loading application function"
      )
    );

  if (typeof activeWhen !== "function")
    throw Error(
      formatErrorMessage(
        24,
        __DEV__ &&
          "The 3rd argument to registerApplication must be an activeWhen function"
      )
    );

  if (!validCustomProps(customProps))
    throw Error(
      formatErrorMessage(
        22,
        __DEV__ &&
          "The optional 4th argument is a customProps and must be an object"
      )
    );
}

// * 校验registerApplication函数的参数,针对于参数是对象形式的传入
export function validateRegisterWithConfig(config) {
  if (Array.isArray(config) || config === null)
    throw Error(
      formatErrorMessage(
        39,
        __DEV__ && "Configuration object can't be an Array or null!"
      )
    );
  const validKeys = ["name", "app", "activeWhen", "customProps"];
  const invalidKeys = Object.keys(config).reduce(
    (invalidKeys, prop) =>
      validKeys.indexOf(prop) >= 0 ? invalidKeys : invalidKeys.concat(prop),
    []
  );
  if (invalidKeys.length !== 0)
    throw Error(
      formatErrorMessage(
        38,
        __DEV__ &&
          `The configuration object accepts only: ${validKeys.join(
            ", "
          )}. Invalid keys: ${invalidKeys.join(", ")}.`,
        validKeys.join(", "),
        invalidKeys.join(", ")
      )
    );
  if (typeof config.name !== "string" || config.name.length === 0)
    throw Error(
      formatErrorMessage(
        20,
        __DEV__ &&
          "The config.name on registerApplication must be a non-empty string"
      )
    );
  if (typeof config.app !== "object" && typeof config.app !== "function")
    throw Error(
      formatErrorMessage(
        20,
        __DEV__ &&
          "The config.app on registerApplication must be an application or a loading function"
      )
    );
  const allowsStringAndFunction = (activeWhen) =>
    typeof activeWhen === "string" || typeof activeWhen === "function";
  if (
    !allowsStringAndFunction(config.activeWhen) &&
    !(
      Array.isArray(config.activeWhen) &&
      config.activeWhen.every(allowsStringAndFunction)
    )
  )
    throw Error(
      formatErrorMessage(
        24,
        __DEV__ &&
          "The config.activeWhen on registerApplication must be a string, function or an array with both"
      )
    );
  if (!validCustomProps(config.customProps))
    throw Error(
      formatErrorMessage(
        22,
        __DEV__ && "The optional config.customProps must be an object"
      )
    );
}

// * 校验在生命周期钩子函数执行时会被作为参数传入
function validCustomProps(customProps) {
  return (
    !customProps ||
    typeof customProps === "function" ||
    (typeof customProps === "object" &&
      customProps !== null &&
      !Array.isArray(customProps))
  );
}

// * 统一规范化registerApplication函数的参数
function sanitizeArguments(
  appNameOrConfig,
  appOrLoadApp,
  activeWhen,
  customProps
) {
  const usingObjectAPI = typeof appNameOrConfig === "object";

  const registration = {
    name: null,
    loadApp: null,
    activeWhen: null,
    customProps: null,
  };

  if (usingObjectAPI) {
    validateRegisterWithConfig(appNameOrConfig);
    registration.name = appNameOrConfig.name;
    registration.loadApp = appNameOrConfig.app;
    registration.activeWhen = appNameOrConfig.activeWhen;
    registration.customProps = appNameOrConfig.customProps;
  } else {
    validateRegisterWithArguments(
      appNameOrConfig,
      appOrLoadApp,
      activeWhen,
      customProps
    );
    registration.name = appNameOrConfig;
    registration.loadApp = appOrLoadApp;
    registration.activeWhen = activeWhen;
    registration.customProps = customProps;
  }

  registration.loadApp = sanitizeLoadApp(registration.loadApp);
  registration.customProps = sanitizeCustomProps(registration.customProps);
  registration.activeWhen = sanitizeActiveWhen(registration.activeWhen);

  return registration;
}

// * 规范化appOrLoadApp函数
function sanitizeLoadApp(loadApp) {
  if (typeof loadApp !== "function") {
    return () => Promise.resolve(loadApp);
  }

  return loadApp;
}
// * 规范化在生命周期钩子函数执行时会被作为参数传入
function sanitizeCustomProps(customProps) {
  return customProps ? customProps : {};
}
// * 规范化sanitizeActiveWhen函数
function sanitizeActiveWhen(activeWhen) {
  let activeWhenArray = Array.isArray(activeWhen) ? activeWhen : [activeWhen];
  activeWhenArray = activeWhenArray.map((activeWhenOrPath) =>
    typeof activeWhenOrPath === "function"
      ? activeWhenOrPath
      : pathToActiveWhen(activeWhenOrPath)
  );

  return (location) =>
    activeWhenArray.some((activeWhen) => activeWhen(location));
}

export function pathToActiveWhen(path) {
  const regex = toDynamicPathValidatorRegex(path);

  return (location) => {
    const route = location.href
      .replace(location.origin, "")
      .replace(location.search, "")
      .split("?")[0];
    return regex.test(route);
  };
}

export function toDynamicPathValidatorRegex(path) {
  let lastIndex = 0,
    inDynamic = false,
    regexStr = "^";

  if (path[0] !== "/") {
    path = "/" + path;
  }

  for (let charIndex = 0; charIndex < path.length; charIndex++) {
    const char = path[charIndex];
    const startOfDynamic = !inDynamic && char === ":";
    const endOfDynamic = inDynamic && char === "/";
    if (startOfDynamic || endOfDynamic) {
      appendToRegex(charIndex);
    }
  }

  appendToRegex(path.length);
  return new RegExp(regexStr, "i");

  function appendToRegex(index) {
    const anyCharMaybeTrailingSlashRegex = "[^/]+/?";
    const commonStringSubPath = escapeStrRegex(path.slice(lastIndex, index));

    regexStr += inDynamic
      ? anyCharMaybeTrailingSlashRegex
      : commonStringSubPath;

    if (index === path.length && !inDynamic) {
      regexStr =
        // use charAt instead as we could not use es6 method endsWith
        regexStr.charAt(regexStr.length - 1) === "/"
          ? `${regexStr}.*$`
          : `${regexStr}([/#].*)?$`;
    }

    inDynamic = !inDynamic;
    lastIndex = index;
  }

  function escapeStrRegex(str) {
    // borrowed from https://github.com/sindresorhus/escape-string-regexp/blob/master/index.js
    return str.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
  }
}
