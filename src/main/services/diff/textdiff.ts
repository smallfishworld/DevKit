/**
 * 文本 diff 引擎已抽至 shared/textdiff（渲染端复制同步需本地重算，与主进程共用一份实现）。
 * 此文件保留作为主进程侧入口，转发到共享引擎。
 */
export { textDiff, normalizeLine, inlineSegs, splitLines } from '../../../shared/textdiff'
