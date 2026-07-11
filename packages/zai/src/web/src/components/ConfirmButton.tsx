import { Button, Modal } from 'antd';
import { useState } from 'react';

interface ConfirmButtonProps {
  title: string;
  content: string;
  onConfirm: () => void | Promise<void>;
  children: React.ReactNode;
  type?: 'primary' | 'default' | 'dashed' | 'text' | 'link';
  danger?: boolean;
  loading?: boolean;
}

export default function ConfirmButton({
  title,
  content,
  onConfirm,
  children,
  type = 'primary',
  danger = false,
  loading = false,
}: ConfirmButtonProps) {
  const [open, setOpen] = useState(false);

  const handleConfirm = async () => {
    await onConfirm();
    setOpen(false);
  };

  return (
    <>
      <Button type={type} danger={danger} loading={loading} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <Modal
        title={title}
        open={open}
        onOk={handleConfirm}
        onCancel={() => setOpen(false)}
        okText="确认"
        cancelText="取消"
      >
        <p>{content}</p>
      </Modal>
    </>
  );
}
