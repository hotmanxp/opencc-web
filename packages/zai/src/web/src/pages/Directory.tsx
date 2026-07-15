import {
  Card,
  Tree,
  Tag,
  Spin,
  message,
  Row,
  Col,
  Typography,
  Modal,
  Button,
  Space,
  Empty,
  Skeleton,
} from 'antd';
import { FolderOutlined, FileOutlined, CopyOutlined, DownloadOutlined } from '@ant-design/icons';
import { useEffect, useState, useCallback } from 'react';
import type { DirectoryStatus, DirInfo } from '@shared/types';
import { api } from '../lib/api';

const { Text } = Typography;

interface TreeNode {
  title: React.ReactNode;
  key: string;
  children?: TreeNode[];
  icon?: React.ReactNode;
  isLeaf?: boolean;
}

function buildTree(info: DirInfo): TreeNode {
  const buildSubTree = (name: string, items: { count: number; items: string[] }): TreeNode => ({
    title: (
      <span>
        {name} <Tag color="blue">{items.count}</Tag>
      </span>
    ),
    key: `${info.path}/${name}`,
    icon: <FolderOutlined />,
    isLeaf: false,
    children: items.items.map((item) => ({
      title: item,
      key: `${info.path}/${name}/${item}`,
      icon: <FileOutlined />,
      isLeaf: true,
    })),
  });

  return {
    title: (
      <span>
        <strong>{info.path}</strong>
        {!info.exists && <Tag color="red">不存在</Tag>}
      </span>
    ),
    key: info.path,
    icon: <FolderOutlined />,
    isLeaf: false,
    children: info.exists
      ? [
          buildSubTree('agents', info.agents),
          buildSubTree('commands', info.commands),
          buildSubTree('skills', info.skills),
          buildSubTree('extensions', info.extensions),
        ]
      : [],
  };
}

interface FilePayload {
  path: string;
  name: string;
  size: number;
  mtime: string;
  content: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export default function Directory() {
  const [data, setData] = useState<DirectoryStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerPath, setViewerPath] = useState<string | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [viewerFile, setViewerFile] = useState<FilePayload | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<DirectoryStatus>('/dirs')
      .then(setData)
      .catch((err) => console.error(err))
      .finally(() => setLoading(false));
  }, []);

  const openFile = useCallback(async (absPath: string) => {
    setViewerPath(absPath);
    setViewerOpen(true);
    setViewerLoading(true);
    setViewerFile(null);
    setViewerError(null);
    try {
      const file = await api.get<FilePayload>(
        `/dirs/file?path=${encodeURIComponent(absPath)}`,
      );
      setViewerFile(file);
    } catch (err) {
      setViewerError(err instanceof Error ? err.message : String(err));
    } finally {
      setViewerLoading(false);
    }
  }, []);

  const handleSelect = useCallback(
    (_keys: React.Key[], info: { node: { isLeaf?: boolean; key: React.Key } }) => {
      const node = info.node;
      if (!node.isLeaf) return;
      openFile(String(node.key));
    },
    [openFile],
  );

  const handleCopy = useCallback(async () => {
    if (!viewerFile) return;
    try {
      await navigator.clipboard.writeText(viewerFile.content);
      message.success('已复制到剪贴板');
    } catch {
      console.error('clipboard copy failed');
    }
  }, [viewerFile]);

  const handleDownload = useCallback(() => {
    if (!viewerFile) return;
    const blob = new Blob([viewerFile.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = viewerFile.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [viewerFile]);

  const handleClose = useCallback(() => {
    setViewerOpen(false);
    setViewerFile(null);
    setViewerError(null);
  }, []);

  if (loading) return <Spin size="large" className="block mx-auto my-20" />;
  if (!data) return null;

  const treeData = [
    { title: 'Nova', key: 'nova', info: data.nova },
    { title: 'OpenCode', key: 'opencode', info: data.opencode },
    { title: 'OpenCC', key: 'opencc', info: data.opencc },
    { title: '全局 Skills', key: 'globalSkills', info: data.globalSkills },
  ];

  return (
    <>
      <Row gutter={[16, 16]}>
        {treeData.map((item) => (
          <Col key={item.key} xs={24} md={12}>
            <Card
              title={
                <span
                  style={{
                    background: 'linear-gradient(90deg, #ff6600, #ff8533)',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                  }}
                >
                  {item.title}
                </span>
              }
              size="small"
            >
              <Text type="secondary" className="block mb-2">
                {item.info.path}
              </Text>
              {item.info.exists ? (
                <Tree
                  showIcon
                  defaultExpandAll
                  treeData={[buildTree(item.info)]}
                  onSelect={handleSelect}
                  style={{
                    background: 'var(--bg-body)',
                    borderRadius: 8,
                    padding: 8,
                  }}
                />
              ) : (
                <Text type="secondary">目录不存在</Text>
              )}
            </Card>
          </Col>
        ))}
      </Row>

      <Modal
        open={viewerOpen}
        onCancel={handleClose}
        footer={null}
        width={760}
        title={
          viewerFile ? (
            <Space direction="vertical" size={0} style={{ width: '100%' }}>
              <span style={{ fontWeight: 600 }}>{viewerFile.name}</span>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {viewerFile.path} · {formatSize(viewerFile.size)} ·{' '}
                {new Date(viewerFile.mtime).toLocaleString()}
              </Text>
            </Space>
          ) : (
            viewerPath ?? '文件预览'
          )
        }
      >
        <Space style={{ marginBottom: 12 }} wrap>
          <Button
            icon={<CopyOutlined />}
            onClick={handleCopy}
            disabled={!viewerFile}
            size="small"
          >
            复制内容
          </Button>
          <Button
            icon={<DownloadOutlined />}
            onClick={handleDownload}
            disabled={!viewerFile}
            size="small"
          >
            下载文件
          </Button>
        </Space>

        {viewerLoading ? (
          <Skeleton active paragraph={{ rows: 8 }} />
        ) : viewerError ? (
          <Empty description={viewerError} />
        ) : viewerFile ? (
          <pre
            style={{
              margin: 0,
              padding: 16,
              background: 'var(--bg-body, #f5f5f5)',
              borderRadius: 8,
              maxHeight: '60vh',
              overflow: 'auto',
              fontSize: 12,
              lineHeight: 1.6,
              fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {viewerFile.content}
          </pre>
        ) : null}
      </Modal>
    </>
  );
}