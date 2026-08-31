import { memo, useCallback, useState } from 'react';
import { message } from 'antd';
import { api } from '../../lib/api.js';
import type { DesktopWallpaperPut } from '../../../../shared/desktopFs.js';

interface WallpaperUploadFieldProps {
  /** 上传成功回调,参数为可直接用于 CSS background 的壁纸 URL(含 /api 前缀) */
  onUploaded: (url: string) => void;
}

/**
 * 桌面壁纸上传控件。
 *
 * 为什么必须用**原生** `<input type="file">`,而不是 antd `<Input type="file">`
 * (历史 bug:选完壁纸图片后"桌面内容被清空",刷新才恢复):
 *
 * rc-input 的 BaseInput 会 `cloneElement(inputElement, { value })`,把内部
 * useMergedValue 维护的 value 注入原生 input。用户选文件后 rc-input 的
 * onChangeInternal 把 state 设成 `e.target.value`,而 file input 的 value 是
 * `C:\fakepath\<name>`;下一次 render 时 React 发现 props.value 与 DOM 不一致,
 * 在 commitUpdate → updateWrapper 里执行 `node.value = "C:\\fakepath\\..."`,
 * 按规范 file input 的 value 只允许被程序化赋值成空串 → 抛 InvalidStateError。
 * 异常发生在 React commit 阶段且没有 error boundary,整棵桌面子树被卸载。
 *
 * 原生 input 不传 `value`/`defaultValue`,React 永远不会回写 value;清空 files
 * 放到 setTimeout(事件与 commit 之后),既规避上述路径,又保证同一张图再次
 * 选中仍能触发 change。
 *
 * 图片本体不进 localStorage:base64 dataURL 动辄数 MB,既撞 quota(静默丢失)
 * 又拖慢读图。改为 PUT /api/desktop/wallpaper 存到 ~/.zai/desktop/wallpapers/,
 * 调用方只持久化返回的 URL。
 */
function WallpaperUploadField({ onUploaded }: WallpaperUploadFieldProps) {
  const [busy, setBusy] = useState(false);

  const upload = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) {
      void message.error('请选择图片文件');
      return;
    }
    setBusy(true);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      if (typeof dataUrl !== 'string') {
        setBusy(false);
        void message.error('读取图片失败');
        return;
      }
      api
        .put<DesktopWallpaperPut>('/desktop/wallpaper', { dataUrl })
        .then((r) => {
          if (!r.ok || !r.url) {
            void message.error(r.error ?? '壁纸保存失败');
            return;
          }
          onUploaded(r.url);
          void message.success('壁纸已更新');
        })
        .catch((e: unknown) => void message.error(e instanceof Error ? e.message : '壁纸保存失败'))
        .finally(() => setBusy(false));
    };
    reader.onerror = () => {
      setBusy(false);
      void message.error('读取图片失败');
    };
    reader.readAsDataURL(file);
  }, [onUploaded]);

  const onChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const el = e.currentTarget;
    const file = el.files?.[0];
    if (file) upload(file);
    setTimeout(() => { el.value = ''; }, 0);
  }, [upload]);

  return (
    <div>
      <input
        data-testid="wallpaper-file-input"
        type="file"
        accept="image/*"
        onChange={onChange}
        style={{ width: '100%', fontSize: 12, color: 'inherit' }}
      />
      {busy && (
        <div
          data-testid="wallpaper-uploading"
          style={{ marginTop: 6, fontSize: 12, color: 'var(--text-secondary, #aaa)' }}
        >
          壁纸上传中…
        </div>
      )}
    </div>
  );
}

export default memo(WallpaperUploadField);

