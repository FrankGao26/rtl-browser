// Copyright 2026 Frank Gao
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import React, { useMemo, useState } from "react";
import type { BuildConfig, BuildJobSummary, ProjectSummary } from "../../contracts/src/types.js";
import type { RtlClient } from "../../client/src/api.js";
import { PathPicker } from "./PathPicker.js";

interface Props {
  client: RtlClient;
  project: ProjectSummary | null;
  config: BuildConfig | null;
  projectRoot: string | null;
  onSaved: (project: ProjectSummary, config: BuildConfig, snapshotDiscarded: boolean) => void | Promise<void>;
  onBuild: (job: BuildJobSummary) => void;
  onError: (message: string) => void;
}

function lines(v: string): string[] {
  return v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}
function kvLines(v: string): Array<{ name: string; value: string | null }> {
  return lines(v).map((s) => {
    const i = s.indexOf("=");
    return i < 0 ? { name: s.trim(), value: null } : { name: s.slice(0, i).trim(), value: s.slice(i + 1).trim() };
  }).filter((x) => x.name);
}

export function BuildForm({ client, project, config, projectRoot, onSaved, onBuild, onError }: Props) {
  const [inputMode, setInputMode] = useState<"filelist" | "sources">(config?.inputMode ?? "filelist");
  const [filelistPath, setFilelistPath] = useState(config?.filelistPath ?? "");
  const [sourcePaths, setSourcePaths] = useState((config?.sourcePaths ?? []).join("\n"));
  const [topModule, setTopModule] = useState(config?.topModule ?? "");
  const [defines, setDefines] = useState((config?.defines ?? []).map((d) => d.value === null || d.value === undefined ? d.name : `${d.name}=${d.value}`).join("\n"));
  const [includeRoots, setIncludeRoots] = useState((config?.includeRoots ?? []).join("\n"));
  const [libraries, setLibraries] = useState((config?.libraries ?? []).join("\n"));
  const [parameters, setParameters] = useState((config?.parameters ?? []).map((p) => `${p.name}=${p.value}`).join("\n"));
  const [language, setLanguage] = useState(config?.language ?? "");
  const [threads, setThreads] = useState(config?.threads ?? 1);
  const [warningAsError, setWarningAsError] = useState(config?.warningAsError ?? false);
  const [warningOptions, setWarningOptions] = useState((config?.warningOptions ?? []).join("\n"));
  const [advanced, setAdvanced] = useState(false);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty = useMemo(() => {
    if (!config) return true;
    return JSON.stringify({
      inputMode, filelistPath, sourcePaths, topModule, defines, includeRoots, libraries,
      parameters, language, threads, warningAsError, warningOptions,
    }) !== JSON.stringify({
      inputMode: config.inputMode,
      filelistPath: config.filelistPath ?? "",
      sourcePaths: (config.sourcePaths ?? []).join("\n"),
      topModule: config.topModule,
      defines: (config.defines ?? []).map((d) => d.value === null || d.value === undefined ? d.name : `${d.name}=${d.value}`).join("\n"),
      includeRoots: config.includeRoots.join("\n"),
      libraries: config.libraries.join("\n"),
      parameters: config.parameters.map((p) => `${p.name}=${p.value}`).join("\n"),
      language: config.language ?? "", threads: config.threads, warningAsError: config.warningAsError,
      warningOptions: (config.warningOptions ?? []).join("\n"),
    });
  }, [config, inputMode, filelistPath, sourcePaths, topModule, defines, includeRoots, libraries, parameters, language, threads, warningAsError, warningOptions]);

  function draft() {
    return {
      inputMode,
      ...(inputMode === "filelist" ? { filelistPath } : { sourcePaths: lines(sourcePaths) }),
      topMode: "explicit" as const,
      topModule,
      defines: kvLines(defines).map((d) => ({ name: d.name, value: d.value })),
      includeRoots: lines(includeRoots),
      libraries: lines(libraries),
      parameters: kvLines(parameters).map((p) => ({ name: p.name, value: p.value ?? "" })),
      language: language || null,
      singleUnit: false,
      threads,
      warningAsError,
      warningOptions: lines(warningOptions),
    };
  }

  async function save(): Promise<{ project: ProjectSummary; config: BuildConfig; snapshotDiscarded: boolean } | null> {
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const d = draft();
      const saved = project
        ? await client.saveConfig(project.projectId, d, project.configRevision)
        : { ...(await client.createProject(d)), snapshotDiscarded: false };
      await onSaved(saved.project, saved.config, saved.snapshotDiscarded);
      setMessage(saved.snapshotDiscarded
        ? "配置已更新；旧快照已删除，请重新编译。"
        : dirty ? "配置已保存（尚未应用到当前快照）。" : "配置已保存。");
      return saved;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      onError(msg);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function doValidate() {
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const result = await client.validateDraft(draft());
      setMessage(result.message || "输入检查通过；这不代表编译通过");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`输入检查失败：${msg}`);
      onError(msg);
    } finally { setBusy(false); }
  }

  async function doBuild() {
    const saved = await save();
    if (!saved) return;
    try {
      setBusy(true);
      const job = await client.build(saved.project.projectId, saved.config.configRevision, crypto.randomUUID());
      setMessage(`构建任务 ${job.jobId.slice(0, 8)} 已启动`);
      onBuild(job);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      onError(msg);
    } finally { setBusy(false); }
  }

  return (
    <div className="build-form">
      <div className="form-hint">工程目录：<span className="mono">{projectRoot ?? "未打开"}</span>。Filelist 内路径自动解析：相对路径以工程目录为基准，支持环境变量。</div>
      <div className="form-grid">
        <label>输入方式
          <select value={inputMode} onChange={(e) => setInputMode(e.target.value as "filelist" | "sources")}>
            <option value="filelist">Filelist</option>
            <option value="sources">有序源文件列表</option>
          </select>
        </label>
        {inputMode === "filelist" ? (
          <label>Filelist 路径
            <span className="input-with-button">
              <input value={filelistPath} onChange={(e) => setFilelistPath(e.target.value)} />
              <button onClick={() => setPicker(true)}>浏览…</button>
            </span>
            <span className="field-help">入口清单；不再选择 -f/-F，程序按工程目录解析。</span>
          </label>
        ) : (
          <label className="wide">源文件（每行一个，保持顺序）
            <textarea rows={5} value={sourcePaths} onChange={(e) => setSourcePaths(e.target.value)} />
            <span className="field-help">相对路径以工程目录为基准，支持环境变量；文件类型交给 slang 判断。</span>
          </label>
        )}
        <label>Top 模块
          <input value={topModule} onChange={(e) => setTopModule(e.target.value)} />
          <span className="field-help">实际编译的顶层模块名，不是文件名。</span>
        </label>
        <div className="form-actions">
          <button onClick={() => setAdvanced((v) => !v)}>{advanced ? "收起高级选项" : "高级选项"}</button>
          <button onClick={() => void doValidate()} disabled={busy}>检查输入</button>
          <button className="primary" onClick={() => void doBuild()} disabled={busy || !topModule.trim()}>编译并建立索引</button>
        </div>
      </div>
      {advanced && (
        <div className="advanced-grid">
          <label>宏定义（每行 NAME 或 NAME=VALUE）<textarea rows={3} value={defines} onChange={(e) => setDefines(e.target.value)} /></label>
          <label>Include 根（每行一个）<textarea rows={3} value={includeRoots} onChange={(e) => setIncludeRoots(e.target.value)} /></label>
          <label>库文件（每行一个）<textarea rows={3} value={libraries} onChange={(e) => setLibraries(e.target.value)} /></label>
          <label>参数覆盖（每行 NAME=VALUE）<textarea rows={3} value={parameters} onChange={(e) => setParameters(e.target.value)} /></label>
          <label>语言模式<input value={language} onChange={(e) => setLanguage(e.target.value)} /></label>
          <label>slang 线程数<input type="number" min={1} max={64} value={threads} onChange={(e) => setThreads(Math.max(1, Math.min(64, Number(e.target.value) || 1)))} /></label>
          <label>警告选项（每行一个，例如 width-trunc）<textarea rows={3} value={warningOptions} onChange={(e) => setWarningOptions(e.target.value)} /></label>
          <label className="check"><input type="checkbox" checked={warningAsError} onChange={(e) => setWarningAsError(e.target.checked)} />warning 作为 error</label>
        </div>
      )}
      <div className="form-status">
        {project ? <span>{dirty ? "有未保存修改" : "配置已保存"}</span> : <span>尚未保存工程</span>}
        {message && <span className="ok-text">{message}</span>}
        {error && <span className="form-error">{error}</span>}
      </div>
      {picker && (
        <PathPicker
          client={client}
          mode="file"
          onPick={(p) => { setFilelistPath(p); setPicker(false); }}
          onClose={() => setPicker(false)}
        />
      )}
    </div>
  );
}
