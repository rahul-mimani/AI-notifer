Create a new file src/parser/BeanExtractor.ts that extracts Spring bean definitions and bean injection points from Java source using web-tree-sitter. Types are defined in src/types.ts (currently open) — import BeanDefinition, MethodSignature, BeanInjection, and CalledMethod and produce values conforming to them exactly. Follow the same code style, error handling, and tree-walking approach used in src/parser/RestExtractor.ts and src/parser/DtoExtractor.ts (both open).
Class shape:
Export a class BeanExtractor with:

Constructor: constructor(parser: Parser) where Parser is imported from web-tree-sitter. Store the parser as a private field.
Method: extractProviders(sourceCode: string, filePath: string): BeanDefinition[] — for provider-side (CDU) extraction. Synchronous. Returns [] on any failure.
Method: extractInjections(sourceCode: string, filePath: string): BeanInjection[] — for consumer-side (POU) extraction. Synchronous. Returns [] on any failure.

Imports:
typescriptimport { Parser, Node as SyntaxNode } from 'web-tree-sitter';
import { BeanDefinition, MethodSignature, BeanInjection, CalledMethod } from '../types';

Part 1 — extractProviders
Rules:

Parse sourceCode. On parse failure or null tree, return [].
Extract the file's packageName from any package_declaration node. If absent, packageName = "".
Extract the file's imports — parse each import_declaration and store as a map simpleName → FQN. Used for resolving type names later.
Walk class_declaration nodes at the top level. For each class:
Case A — stereotype-annotated class:

If the class is annotated with @Component, @Service, @Repository, or @Controller, emit one BeanDefinition.
name: if the annotation has a string argument (e.g. @Service("foo") or @Service(value="foo")), use that string. Else use the camelCased class name (first letter lowercased — e.g. CustomerService → "customerService").
type: ${packageName}.${className} if packageName is non-empty, else className.
packageName: the file's package.
scope: if class has @Scope("...") annotation, use its string value; else "singleton".
qualifiers: array of strings. Include the literal "@Primary" if class has @Primary. Include the full source text of any @Qualifier(...) annotation.
conditionals: array of full annotation source texts (including @ and args) for any annotation whose name starts with ConditionalOn (matches @ConditionalOnProperty, @ConditionalOnBean, @ConditionalOnClass, @ConditionalOnMissingBean, @ConditionalOnExpression, etc).
exported: false if packageName contains .internal., .impl., or .private. (case-sensitive substring match); else true.
publicMethods: iterate method_declaration nodes in the class body. For each method with a public modifier:

Skip if method name is equals, hashCode, or toString.
Skip constructors (they're constructor_declaration in the grammar, not method_declaration, but double-check).
Emit a MethodSignature: name = method name; returnType = return type as source text ("void" if void); parameters = array of { name, type } from formal parameters. If the type is ResponseEntity<T>, keep it as "ResponseEntity<T>" verbatim — do not unwrap here (unlike the REST extractor).


file: use filePath.
line: 1-indexed line of the class declaration.

Case B — @Configuration class with @Bean methods:

If the class is annotated with @Configuration, iterate its method_declaration children. For each method annotated with @Bean:

Emit one BeanDefinition per @Bean method.
name: if @Bean(name="x") or @Bean("x") is present, use "x"; else the method name.
type: the method's return type as source text, resolved to FQN if possible via the file's imports map (else use as-written).
packageName: the file's package.
scope: if the method has @Scope("..."), use its value; else "singleton".
qualifiers: "@Primary" if @Primary on the method; plus any @Qualifier(...) source.
conditionals: any @ConditionalOn* annotations on the method.
exported: same rule as Case A, based on file's packageName.
publicMethods: empty array [] (cross-file resolution of the return type's methods is out of scope for v1).
file: filePath.
line: 1-indexed line of the @Bean method declaration.



A class may match both Case A and Case B (a @Configuration class is also usable as an injectable bean), but for v1 treat @Configuration classes as Case B only — do not also emit them as Case A beans.
Aggregate all BeanDefinition entries and return the flat array.


Part 2 — extractInjections
Rules:

Parse sourceCode. On failure, return [].
Extract packageName and imports map as in Part 1.
Walk class_declaration nodes at the top level. For each class, extract:

enclosingClass: simple class name.
Injection points from two patterns:

Pattern A — field injection:

For each field_declaration in the class body annotated with @Autowired, @Resource, or @Inject:

For each variable_declarator inside (fields can declare multiple, but injection fields typically declare one):

field: variable name.
providerType: the field's declared type as source text. If the simple name matches an import in the imports map, replace with the imported FQN. Otherwise keep the raw type name.
qualifier: value of any @Qualifier("...") annotation on the field; else null.
line: 1-indexed line of the field declaration.





Pattern B — constructor injection:

If the class has exactly one constructor_declaration and its parameter list is non-empty:

For each formal parameter:

field: parameter name (used as the "field" identifier for calledMethods matching).
providerType: parameter's type, resolved via imports map when possible.
qualifier: value of any @Qualifier("...") annotation on the parameter; else null.
line: 1-indexed line of the constructor declaration.






For each injection point, compute calledMethods:

Within the enclosing class body, find all method-call expressions of the form <field>.<methodName>(...) where <field> matches the injection point's field name.
Tree-sitter node for a method call in Java is method_invocation. It has an object field (the receiver) and a name field (the method name).
Deduplicate by method name.
Emit one CalledMethod per unique method: { signature: "${methodName}(...)", confidence: 'declared' }.
If no matching calls exist, calledMethods = [] (still emit the injection).


Fill remaining fields on each BeanInjection:

class: the enclosing class simple name.
file: filePath.


Aggregate and return.


Implementation guidance:

Reuse the walk(node, visitor) recursive helper pattern from the other extractors. Keep this file self-contained.
Java grammar node types you'll use: package_declaration, import_declaration, class_declaration, class_body, field_declaration, variable_declarator, constructor_declaration, method_declaration, formal_parameters, formal_parameter, annotation, marker_annotation, annotation_argument_list, element_value_pair, modifiers, method_invocation, type_identifier, generic_type, identifier, string_literal.
When matching annotation names, strip the leading @ and compare against the annotation's name node text. Handle both fully-qualified (@org.springframework.stereotype.Service) and simple (@Service) forms — match on the last segment.
For extracting a string argument from an annotation: walk its annotation_argument_list. It may contain either a single unnamed value (like @Service("foo")) or element_value_pair children (like @Service(value="foo")). Handle both. Strip quotes from string_literal text.
camelCase conversion: "CustomerService" → "customerService". Just lowercase the first character.
When finding method_invocation nodes for calledMethods, only consider invocations whose object field is an identifier matching the injection field name. Skip chained calls where the object is another method call (v1 simplification).

Error handling:

Wrap each public method's outermost logic in try/catch. On exception, console.warn with file path and error, return [].

Do not:

Do not use tree-sitter query strings.
Do not use fs or other Node built-ins beyond what's imported.
Do not process nested classes for v1.
Do not throw. Return [] on any failure.
Do not emit a BeanDefinition for a class that has no matching stereotype or @Configuration annotation.
Do not resolve types beyond the file's own imports (no cross-file resolution).

Expected output for the provided fixtures:
Running extractProviders on test/fixtures/service-bean.java should return exactly one BeanDefinition:
typescript{
  name: "customerService",
  type: "com.example.cdu.service.CustomerService",
  packageName: "com.example.cdu.service",
  scope: "singleton",
  qualifiers: [],
  conditionals: [],
  exported: true,
  publicMethods: [
    { name: "getById", returnType: "CustomerResponse", parameters: [{ name: "id", type: "String" }] },
    { name: "updatePhone", returnType: "void", parameters: [{ name: "id", type: "String" }, { name: "phone", type: "String" }] }
  ],
  file: "service-bean.java",
  line: 6
}
Running extractInjections on test/fixtures/pou-injection.java should return exactly one BeanInjection:
typescript{
  providerType: "com.example.cdu.service.CustomerService",
  qualifier: null,
  calledMethods: [
    { signature: "getById(...)", confidence: "declared" },
    { signature: "updatePhone(...)", confidence: "declared" }
  ],
  file: "pou-injection.java",
  line: 10,
  class: "PouService",
  field: "customerService"
}
Complete the file. Write clean, readable code. Add brief comments only where tree-walking or annotation parsing is non-obvious.