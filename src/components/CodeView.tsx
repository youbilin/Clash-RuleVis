import type { ReactNode } from 'react';

function renderValue(value: string, keyPrefix?: ReactNode): ReactNode {
  const commentIndex = value.search(/\s#/);
  const core = commentIndex >= 0 ? value.slice(0, commentIndex) : value;
  const comment = commentIndex >= 0 ? value.slice(commentIndex) : '';
  const trimmed = core.trim();
  let content: ReactNode = core;
  if (/^['"].*['"]$/.test(trimmed)) content = <span className="tok-str">{core}</span>;
  else if (/^-?\d+(\.\d+)?$/.test(trimmed)) content = <span className="tok-num">{core}</span>;
  else if (/^(true|false|null)$/i.test(trimmed)) content = <span className="tok-num">{core}</span>;
  else if (/^(DIRECT|REJECT|MATCH)(,|$)/.test(trimmed)) content = <span className="tok-rule">{core}</span>;
  return (
    <>
      {keyPrefix}
      {content}
      {comment ? <span className="tok-comment">{comment}</span> : null}
    </>
  );
}

function highlightLine(line: string): ReactNode {
  if (/^\s*#/.test(line)) return <span className="tok-comment">{line}</span>;
  const listMapping = line.match(/^(\s*)(- )([^\s:#][^:]*):(\s.*|)$/);
  if (listMapping) {
    const [, indent, dash, key, rest] = listMapping;
    return (
      <>
        {indent}
        <span className="tok-dash">{dash}</span>
        <span className="tok-key">{key}</span>:{renderValue(rest)}
      </>
    );
  }
  const mapping = line.match(/^(\s*)([^\s:#][^:]*):(\s.*|)$/);
  if (mapping) {
    const [, indent, key, rest] = mapping;
    return (
      <>
        {indent}
        <span className="tok-key">{key}</span>:{renderValue(rest)}
      </>
    );
  }
  const list = line.match(/^(\s*)(- )(.*)$/);
  if (list) {
    const [, indent, dash, rest] = list;
    const firstComma = rest.indexOf(',');
    if (firstComma > 0 && /^[A-Z-]+$/.test(rest.slice(0, firstComma))) {
      return (
        <>
          {indent}
          <span className="tok-dash">{dash}</span>
          <span className="tok-rule">{rest.slice(0, firstComma)}</span>
          {rest.slice(firstComma)}
        </>
      );
    }
    return (
      <>
        {indent}
        <span className="tok-dash">{dash}</span>
        {renderValue(rest)}
      </>
    );
  }
  return <>{line}</>;
}

export function YamlView({ yaml, maxHeight }: { yaml: string; maxHeight?: number | string }) {
  const lines = yaml.split('\n');
  return (
    <div className="code-view" style={maxHeight ? { maxHeight } : undefined}>
      {lines.map((line, index) => (
        <div className="code-line" key={index}>
          <span className="code-ln">{index + 1}</span>
          <span className="code-text">{line ? highlightLine(line) : ' '}</span>
        </div>
      ))}
    </div>
  );
}

export function DiffView({ diff, maxHeight }: { diff: string; maxHeight?: number | string }) {
  const lines = diff.split('\n');
  return (
    <div className="diff-view" style={maxHeight ? { maxHeight } : undefined}>
      {lines.map((raw, index) => {
        let line = raw;
        let className = '';
        let sign = ' ';
        if (/^(---|\+\+\+|Index:|={3,}|diff )/.test(line)) {
          className = 'meta';
        } else if (line.startsWith('@@')) {
          className = 'hunk';
        } else if (line.startsWith('+')) {
          className = 'add';
          sign = '+';
          line = line.slice(1);
        } else if (line.startsWith('-')) {
          className = 'del';
          sign = '-';
          line = line.slice(1);
        } else if (line.startsWith(' ')) {
          line = line.slice(1);
        }
        return (
          <div className={`diff-line ${className}`} key={index}>
            <span className="diff-sign">{sign}</span>
            <span>{line || ' '}</span>
          </div>
        );
      })}
    </div>
  );
}
