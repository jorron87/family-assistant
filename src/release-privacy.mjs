const docs=new Set(['aktiviteter.md','architecture.md','integrations.md','kildegjennomgang-policy.md','mobilinnsending.md','operations.md','release-review.md','ringeklokke.md','runbook.md','setup.md','git-workflow.md']);
const roots=new Set(['.gitattributes','.gitignore','AGENTS.md','CONTRIBUTING.md','LICENSE','README.md','SECURITY.md','package.json','package-lock.json']);
export function allowedReleasePath(path){
 if(roots.has(path))return true;
 if(path.startsWith('docs/'))return docs.has(path.slice(5));
 if(path.startsWith('config/'))return /^config\/[^/]+\.example\.json$/.test(path)||path==='config/phone-image-requirements.txt'||/^config\/vigilo-keepalive\/(?:[^/]+\.(?:js|json)|README\.md)$/.test(path);
 if(path.startsWith('.githooks/'))return /^\.githooks\/(pre-commit|pre-push|commit-msg)$/.test(path);
 if(path.startsWith('.github/'))return /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path);
 return /^(?:src|public|test|scripts)\//.test(path)&&/\.(?:mjs|cjs|js|css|html|svg|webmanifest|py|ps1|sh|service|cs|csproj|json|txt)$/.test(path)&&!/(?:^|\/)(?:\.local|drift|audit|node_modules|artifacts|tmp|\.runtime)(?:\/|$)/.test(path);
}
export function inspectReleaseText(text,policy={}){
 const reasons=[];
 if(text.includes('\0'))reasons.push('binary content');
 if(/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AIza[A-Za-z0-9_-]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(text))reasons.push('possible credential');
 if(/C:[\\/]+Users[\\/]+[^\\/"'\s]+|\/home\/(?!dashboard\b|user\b)[a-z][a-z0-9_-]+/i.test(text))reasons.push('personal home path');
 const emails=text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)??[];
 if(emails.some(e=>!/@(?:[\w.-]*example\.(?:com|org|net)|[\w.-]+\.(?:test|invalid|local))$/i.test(e)))reasons.push('non-example email');
 for(const term of policy.privateTerms??[])if(term.length>=3&&text.toLocaleLowerCase().includes(term.toLocaleLowerCase()))reasons.push('local private identifier');
 for(const pattern of policy.privatePatterns??[])if(new RegExp(pattern,'u').test(text))reasons.push('local private pattern');
 return [...new Set(reasons)];
}
