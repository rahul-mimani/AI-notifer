npm install -g yo generator-code
yo code
# Choose: New Extension (TypeScript), name: ai-change-impact-notifier, 
# bundler: webpack, package manager: npm, init git: yes

cd ai-change-impact-notifier
npm install web-tree-sitter yaml
mkdir -p resources
curl -L -o resources/tree-sitter-java.wasm https://github.com/tree-sitter/tree-sitter-java/releases/latest/download/tree-sitter-java.wasm


cp node_modules/tree-sitter-wasms/out/tree-sitter-java.wasm resources/