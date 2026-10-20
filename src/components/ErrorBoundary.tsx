import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ui] 渲染失败：', error.message.replace(/https?:\/\/\S+/g, '[url]'), info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="app-crash">
        <div className="app-crash-card">
          <div className="app-crash-mark"><AlertTriangle size={22} /></div>
          <h1>界面渲染出错</h1>
          <p>{this.state.error.message || '未知错误'}</p>
          <div className="app-crash-actions">
            <button className="btn btn-outline" onClick={() => this.setState({ error: null })}>
              重试
            </button>
            <button className="btn btn-primary" onClick={() => window.location.reload()}>
              <RefreshCw size={13} /> 重新加载
            </button>
          </div>
          <span>工作区数据保存在本机，不会因为界面刷新丢失已保存内容。</span>
        </div>
      </div>
    );
  }
}
