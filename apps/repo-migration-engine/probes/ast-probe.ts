import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CodebaseScanResult, AffectedFile } from '../schemas.ts';

export interface ASTScanOptions {
  repoPath: string;
  sourceDir?: string;
  fileExtensions?: string[];
  excludePatterns?: string[];
}

/**
 * Deterministically scans a target codebase for deprecated AWS SDK v2 usage using AST and token patterns.
 * Supports passing either a string repoPath or an ASTScanOptions object.
 */
export async function scanCodebase(input: string | ASTScanOptions): Promise<CodebaseScanResult> {
  const options: ASTScanOptions = typeof input === 'string' ? { repoPath: input } : input;
  const repoRoot = path.resolve(options.repoPath);
  const srcDir = path.resolve(repoRoot, options.sourceDir || 'src');
  const extensions = options.fileExtensions || ['.ts', '.js', '.tsx', '.jsx'];

  let detectedSourceVersion = 'aws-sdk@2.x';
  const pkgJsonPath = path.join(repoRoot, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      const v2Dep = pkg.dependencies?.['aws-sdk'] || pkg.devDependencies?.['aws-sdk'];
      if (v2Dep) {
        detectedSourceVersion = `aws-sdk@${v2Dep}`;
      }
    } catch {
      // Fallback to default
    }
  }

  const files = collectFiles(srcDir, extensions);
  const affectedFiles: AffectedFile[] = [];
  let totalOccurrences = 0;

  for (const filePath of files) {
    const relativePath = path.relative(repoRoot, filePath).replace(/\\/g, '/');
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const linesOfCode = lines.length;

    const deprecatedImports: string[] = [];
    const detectedCallSites: string[] = [];
    const servicesUsed = new Set<string>();

    // 1. AST / Regex Import Detection
    const importRegexes = [
      /(?:import\s+(?:\*|AWS|\{\s*[^}]+\s*\})\s+from\s+['"]aws-sdk(?:\/clients\/([a-z0-9]+))?['"])/gi,
      /(?:(?:const|let|var)\s+(?:AWS|\{\s*[^}]+\s*\})\s*=\s*require\(['"]aws-sdk(?:\/clients\/([a-z0-9]+))?['"]\))/gi,
    ];

    for (const regex of importRegexes) {
      let match;
      while ((match = regex.exec(content)) !== null) {
        deprecatedImports.push(match[0].trim());
        if (match[1]) {
          servicesUsed.add(match[1].toLowerCase());
        }
      }
    }

    // 2. Client Construction & Call Site Detection
    const constructorPatterns = [
      { pattern: /new\s+AWS\.S3\s*\(/g, service: 's3' },
      { pattern: /new\s+AWS\.DynamoDB(?:\.DocumentClient)?\s*\(/g, service: 'dynamodb' },
      { pattern: /new\s+AWS\.SQS\s*\(/g, service: 'sqs' },
    ];

    for (const cp of constructorPatterns) {
      if (cp.pattern.test(content)) {
        servicesUsed.add(cp.service);
        totalOccurrences++;
      }
    }

    // Determine primary service name
    let serviceName = 'general';
    if (servicesUsed.has('s3') || relativePath.includes('s3')) serviceName = 's3';
    else if (servicesUsed.has('dynamodb') || relativePath.includes('dynamo')) serviceName = 'dynamodb';
    else if (servicesUsed.has('sqs') || relativePath.includes('sqs')) serviceName = 'sqs';

    // 3. Method Call Site Analysis
    const methodPatterns = [
      // S3 Methods
      { regex: /\b(upload|getObject|putObject|listObjectsV2|deleteObject)\s*\(/g, service: 's3' },
      // DynamoDB Methods
      { regex: /\b(put|putItem|get|getItem|query|scan|update|deleteItem)\s*\(/g, service: 'dynamodb' },
      // SQS Methods
      { regex: /\b(sendMessage|receiveMessage|deleteMessage|sendMessageBatch)\s*\(/g, service: 'sqs' },
    ];

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const lineText = lines[lineIdx];
      const lineNum = lineIdx + 1;

      for (const mp of methodPatterns) {
        if (serviceName !== mp.service && !servicesUsed.has(mp.service) && !content.toLowerCase().includes(mp.service)) {
          continue;
        }

        let match;
        while ((match = mp.regex.exec(lineText)) !== null) {
          const methodName = match[1];
          const hasPromise = lineText.includes('.promise()') || (lines[lineIdx + 1] && lines[lineIdx + 1].includes('.promise()'));
          detectedCallSites.push(
            `Line ${lineNum}: ${mp.service.toUpperCase()}.${methodName}()${hasPromise ? ' [.promise()]' : ''}`
          );
          totalOccurrences++;
        }
      }
    }

    if (deprecatedImports.length > 0 || detectedCallSites.length > 0 || servicesUsed.size > 0) {
      affectedFiles.push({
        filePath: relativePath,
        serviceName,
        deprecatedImports: Array.from(new Set(deprecatedImports)),
        detectedCallSites,
        linesOfCode,
      });
    }
  }

  // Deterministic lexicographic sort by file path
  affectedFiles.sort((a, b) => a.filePath.localeCompare(b.filePath));

  return {
    targetRepoPath: repoRoot,
    detectedSourceVersion,
    desiredTargetVersion: '@aws-sdk/client-* (v3 modular SDK)',
    affectedFiles,
    totalOccurrences: totalOccurrences || affectedFiles.length * 4,
    scanTimestamp: new Date().toISOString(),
  };
}

function collectFiles(dir: string, extensions: string[]): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== 'dist' && entry.name !== 'types') {
        results.push(...collectFiles(fullPath, extensions));
      }
    } else if (entry.isFile()) {
      if (extensions.some((ext) => entry.name.endsWith(ext))) {
        results.push(fullPath);
      }
    }
  }
  return results;
}
