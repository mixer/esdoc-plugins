const path = require("path");
const ts = require("typescript");
const CommentParser = require("esdoc/out/src/Parser/CommentParser").default;

class Plugin {
  constructor() {
    this._enable = true;
    this._propertyTags = [];
    this._splices = [];
  }

  onStart(ev) {
    if (!ev.data.option) return;
    if ("enable" in ev.data.option) this._enable = ev.data.option.enable;
  }

  onHandleConfig(ev) {
    if (!this._enable) return;

    if (!ev.data.config.includes) ev.data.config.includes = [];
    ev.data.config.includes.push("\\.ts$", "\\.js$");
  }

  onHandleCodeParser(ev) {
    if (!this._enable) return;

    const esParser = ev.data.parser;
    const esParserOption = ev.data.parserOption;
    const filePath = ev.data.filePath;

    // ev.data.parser = this._tsParser.bind(this, esParser, esParserOption, filePath);

    ev.data.parser = code => {
      try {
        return this._tsParser(esParser, esParserOption, filePath, code);
      } catch (e) {
        console.log(e);
      }
    };
  }

  // https://github.com/Microsoft/TypeScript/blob/master/src/services/transpile.ts#L26
  _tsParser(esParser, esParserOption, filePath, code) {
    // return if not typescript
    const ext = path.extname(filePath);
    if (ext !== ".ts" && ext !== ".tsx") return esParser(code);

    const splices = (this._splices = []);

    // create ast and get target nodes
    const sourceFile = (this._sourceFile = ts.createSourceFile(
      filePath,
      code,
      ts.ScriptTarget.Latest,
      true
    ));
    const nodes = this._getTargetTSNodes(sourceFile, code);

    // rewrite jsdoc comment
    nodes.sort((a, b) => b.node.pos - a.node.pos); // hack: transpile comment with reverse
    splices.sort((a, b) => b.pos - a.pos);
    const codeChars = [...code];
    for (const { node, tags } of nodes) {
      while (splices.length && splices[0].pos > node.pos) {
        const { pos, n, text } = splices.shift();
        codeChars.splice(pos, n, text);
      }

      const jsDocNode = this._getJSDocNode(node);
      if (jsDocNode && jsDocNode.comment)
        codeChars.splice(jsDocNode.pos, jsDocNode.end - jsDocNode.pos);
      codeChars.splice(
        node.pos,
        0,
        `\n/*${CommentParser.buildComment(tags)} */\n`
      );
    }

    while (splices.length) {
      const { pos, n, text } = splices.shift();
      codeChars.splice(pos, n, text);
    }

    const newTSCode = codeChars.join("");
    // transpile typescript to es
    const esCode = this._transpileTS2ES(newTSCode, ext === ".tsx");

    return esParser(esCode);
  }

  _getTargetTSNodes(sourceFile, code) {
    const nodes = [];
    const walk = node => {
      switch (node.kind) {
        case ts.SyntaxKind.PropertyDeclaration:
          this._propertyTags.push(this._parseClassProperty(node));
          break;
        case ts.SyntaxKind.InterfaceDeclaration:
          this._parseInterface(node);
          break;
        case ts.SyntaxKind.TypeAliasDeclaration:
          this._parseType(node);
          break;
        case ts.SyntaxKind.ClassDeclaration:
        case ts.SyntaxKind.MethodDeclaration:
        case ts.SyntaxKind.GetAccessor:
        case ts.SyntaxKind.SetAccessor:
        case ts.SyntaxKind.Constructor:
        case ts.SyntaxKind.FunctionDeclaration:
          nodes.push({ node, tags: this._transpileComment(node) });
          break;
      }

      ts.forEachChild(node, walk);

      if (node.kind === ts.SyntaxKind.ClassDeclaration) {
        this._applyConstructorTags(
          node,
          nodes,
          this._propertyTags.filter(Boolean)
        );
        this._propertyTags = [];
      }
    };

    walk(sourceFile);
    return nodes;
  }

  _applyConstructorTags(node, nodes, propertyTags) {
    const ctor = node.members.find(m => m.kind === ts.SyntaxKind.Constructor);
    const tags = propertyTags.map(property => {
      return `/*${CommentParser.buildComment(
        property.tags
      )} */\nthis.${property.name} = undefined;`;
    });

    if (ctor) {
      this._splices.push({
        pos: ctor.body.pos,
        n: ctor.body.end - ctor.body.pos,
        text: `{\n${tags.join("\n")}\n}`
      });
    } else {
      this._splices.push({
        pos: node.end - 1,
        n: 0,
        text: `\nconstructor(){\n${tags.join("\n")}\n`
      });
    }
  }

  _getJSDocNode(node) {
    if (!node.jsDoc) return null;

    const comments = ts.getLeadingCommentRanges(
      this._sourceFile.text,
      node.pos
    );
    let contents = "";

    comments.forEach(comment => {
      const text = this._sourceFile.text.substring(comment.pos, comment.end);
      const leader = /( |\t)* \* /.exec(text);
      if (!leader) {
        return;
      }

      const leadingSpaces = leader[0].length;
      contents += text
        .split("\n")
        .map(line => line.slice(leadingSpaces))
        .join("\n");
    });

    return {
      pos: comments[0].pos,
      end: comments[comments.length - 1].end,
      text: contents
    };
  }

  _getTranspilationTags(node) {
    const jsDocNode = this._getJSDocNode(node);
    const esNode = {
      type: "CommentBlock",
      value: `*\n${jsDocNode ? jsDocNode.text : ""}`
    };
    const tags = CommentParser.parse(esNode);
    this._applyLOC(node, tags);
    return tags;
  }

  _transpileComment(node) {
    const tags = this._getTranspilationTags(node);

    switch (node.kind) {
      case ts.SyntaxKind.ClassDeclaration:
        break;
      case ts.SyntaxKind.Constructor:
      case ts.SyntaxKind.MethodDeclaration:
        tags.push({
          tagName: "@access",
          tagValue: this._getAccessModifier(node.modifiers, tags)
        });
        this._applyCallableParam(node, tags);
        this._applyCallableReturn(node, tags);
        break;
      case ts.SyntaxKind.GetAccessor:
        this._applyClassMethodGetter(node, tags);
        break;
      case ts.SyntaxKind.SetAccessor:
        this._applyClassMethodSetter(node, tags);
        break;
      case ts.SyntaxKind.FunctionDeclaration:
        this._applyCallableParam(node, tags);
        this._applyCallableReturn(node, tags);
        break;
    }

    return tags;
  }

  _applyLOC(node, tags, code) {
    let loc = 1;
    const codeChars = this._sourceFile.text;
    for (let i = 0; i < node.pos; i++) {
      if (codeChars[i] === "\n") loc++;
    }
    tags.push({ tagName: "@lineNumber", tagValue: `${loc}` });
  }

  _applyCallableParam(node, tags) {
    const types = node.parameters.map(param => {
      if (node.kind === ts.SyntaxKind.Constructor && param.modifiers) {
        const modifier = param.modifiers.find(m => {
          return (
            m.kind === ts.SyntaxKind.PrivateKeyword ||
            m.kind === ts.SyntaxKind.PublicKeyword ||
            m.kind === ts.SyntaxKind.ProtectedKeyword
          );
        });

        if (modifier) {
          const tags = [
            {
              tagName: "@access",
              tagValue: this._getAccessModifier(param.modifiers, [])
            },
            {
              tagName: "@type",
              tagValue: `{${this._getTypeFromAnnotation(param.type)}}`
            }
          ];

          if (
            param.modifiers.some(m => m.kind === ts.SyntaxKind.ReadonlyKeyword)
          ) {
            tags.push({ tagName: "@readonly", tagValue: "" });
          }

          this._splices.push({
            pos: param.modifiers.pos,
            n: param.modifiers.end - param.modifiers.pos,
            text: ""
          });
          this._propertyTags.push({
            name: param.name.text,
            tags
          });
        }
      }

      return {
        type: this._getTypeFromAnnotation(param.type),
        name: param.name.text
      };
    });

    const paramTags = tags.filter(tag => tag.tagName === "@param");

    // merge
    // case: params without comments
    if (paramTags.length === 0 && types.length) {
      const tmp = types.map(({ type, name }) => {
        return {
          tagName: "@param",
          tagValue: `{${type}} ${name}`
        };
      });
      tags.push(...tmp);
      return;
    }

    // case: params with comments
    if (paramTags.length === types.length) {
      for (let i = 0; i < paramTags.length; i++) {
        const paramTag = paramTags[i];
        const type = types[i];
        if (paramTag.tagValue.charAt(0) !== "{") {
          // does not have type
          paramTag.tagValue = `{${type.type}} ${paramTag.tagValue}`;
        }
      }
      return;
    }

    // case: mismatch params and comments
    throw new Error("mismatch params and comments");
  }

  _applyCallableReturn(node, tags) {
    if (!node.type) return;

    // get type
    const type = this._getTypeFromAnnotation(node.type);
    if (!type) return;

    // get comments
    const returnTag = tags.find(
      tag => tag.tagName === "@return" || tag.tagName === "@returns"
    );

    // merge
    if (returnTag && returnTag.tagValue.charAt(0) !== "{") {
      // return with comment but does not have type
      returnTag.tagValue = `{${type}} ${returnTag.tagValue}`;
    } else {
      tags.push({ tagName: "@return", tagValue: `{${type}}` });
    }
  }

  _applyClassMethodGetter(node, tags) {
    if (!node.type) return;

    // get type
    const type = this._getTypeFromAnnotation(node.type);
    if (!type) return;

    // get comments
    const typeComment = tags.find(tag => tag.tagName === "@type");

    if (typeComment && typeComment.tagValue.charAt(0) !== "{") {
      // type with comment but does not have tpe
      typeComment.tagValue = `{${type}}`;
    } else {
      tags.push({ tagName: "@type", tagValue: `{${type}}` });
    }
  }

  _applyClassMethodSetter(node, tags) {
    if (!node.parameters) return;

    // get type
    const type = this._getTypeFromAnnotation(node.parameters[0].type);
    if (!type) return;

    // get comment
    const typeComment = tags.find(tag => tag.tagName === "@type");
    if (typeComment) return;

    // merge
    // case: param without comment
    tags.push({ tagName: "@type", tagValue: `{${type}}` });
  }

  _parseClassProperty(node, comment) {
    const tags = this._getTranspilationTags(node, comment);
    tags.push({
      tagName: "@access",
      tagValue: this._getAccessModifier(node.modifiers, tags)
    });

    // get type
    let type = "*";
    if (node.type) {
      type = this._getTypeFromAnnotation(node.type, "*");
    }
    if (node.initializer && type === "*") {
      type = this._getTypeFromAnnotation(node.initializer, "*");
    }

    // get comments
    const typeComment = tags.find(tag => tag.tagName === "@type");
    if (typeComment && typeComment.tagValue.charAt(0) !== "{") {
      // type with comment but does not have tpe
      typeComment.tagValue = `{${type}} ${typeComment.tagValue}`;
    } else {
      tags.push({ tagName: "@type", tagValue: `{${type}}` });
    }

    this._splices.push({ pos: node.pos, n: node.end - node.pos, text: "" });

    return { name: node.name.text, tags };
  }

  _parseInterface(node) {
    const tags = this._getTranspilationTags(node);
    const name = this._addGenerics(node.name.text, node.typeParameters);
    tags.push({ tagName: "@typedef", tagValue: `{Object} ${name}` });
    node.members.forEach(member => {
      const jsDocNode = this._getJSDocNode(member);
      let comment = `{${this._getTypeFromAnnotation(member.type)}} ${member.name
        .text}`;
      if (jsDocNode) {
        comment += ` ${jsDocNode.text}`;
      }
      tags.push({ tagName: "@property", tagValue: comment });
    });

    this._splices.push({
      pos: this._sourceFile.text.length,
      n: 0,
      text: `\n/*${CommentParser.buildComment(tags)} */\n`
    });
  }

  _parseType(node) {
    const tags = this._getTranspilationTags(node);
    const name = this._addGenerics(node.name.text, node.typeParameters);
    tags.push({
      tagName: "@typedef",
      tagValue: `{${this._getTypeFromAnnotation(node.type)}} ${name}`
    });
    this._splices.push({
      pos: 0,
      n: 0,
      text: `\n/*${CommentParser.buildComment(tags)} */\n`
    });
  }

  _addGenerics(name, typeArguments) {
    if (typeArguments && typeArguments.length) {
      name +=
        "<" +
        typeArguments
          .map(param => this._getTypeFromAnnotation(param))
          .join(", ") +
        ">";
    }

    return name;
  }

  _getAccessModifier(modifiers, tags, defaultModifier = "public") {
    const existing = tags.find(({ tagName }) => tagName === "@access");
    if (existing) return existing.tagValue;
    if (!modifiers) return defaultModifier;

    if (modifiers.some(m => ts.SyntaxKind.PrivateKeyword === m.kind)) {
      return "private";
    }

    if (modifiers.some(m => ts.SyntaxKind.ProtectedKeyword === m.kind)) {
      return "protected";
    }

    return defaultModifier;
  }

  _getTypeFromAnnotation(typeNode, fallback = this._getNodeText(typeNode)) {
    switch (typeNode.kind) {
      case ts.SyntaxKind.NumericLiteral:
        return "number";
      case ts.SyntaxKind.NumberKeyword:
        return "number";

      case ts.SyntaxKind.StringLiteral:
        return "string";
      case ts.SyntaxKind.StringKeyword:
        return "string";

      case ts.SyntaxKind.TypePredicate:
        return "boolean";
      case ts.SyntaxKind.TrueKeyword:
        return "boolean";
      case ts.SyntaxKind.FalseKeyword:
        return "boolean";
      case ts.SyntaxKind.BooleanKeyword:
        return "boolean";

      case ts.SyntaxKind.UndefinedKeyword:
        return "undefined";
      case ts.SyntaxKind.VoidKeyword:
        return "undefined";

      case ts.SyntaxKind.TypeReference:
        return this._addGenerics(
          typeNode.typeName.text,
          typeNode.typeArguments
        );
      case ts.SyntaxKind.LiteralType:
        return this._getNodeText(typeNode).trim();
      case ts.SyntaxKind.ArrayType:
        return `${this._getTypeFromAnnotation(typeNode.elementType)}[]`;
      case ts.SyntaxKind.UnionType:
        return typeNode.types
          .map(unionNode => this._getTypeFromAnnotation(unionNode))
          .join(" | ");
      case ts.SyntaxKind.FunctionType:
        const params = typeNode.parameters.map(paramNode => {
          return `${paramNode.name.text}: ${this._getTypeFromAnnotation(
            paramNode.type
          )}`;
        });
        return `function(${params.join(", ")})`;

      case ts.SyntaxKind.ObjectKeyword:
        return "Object";
      case ts.SyntaxKind.AnyKeyword:
        return "*";
      case ts.SyntaxKind.ThisType:
        return "this";
      case ts.SyntaxKind.Identifier:
        return typeNode.text;
      case ts.SyntaxKind.ParenthesizedType:
        return "Object";
    }

    return fallback;
  }

  _getNodeText(node) {
    return this._sourceFile.text.slice(node.pos, node.end);
  }

  _transpileTS2ES(tsCode, isJsx) {
    // todo
    const esOption = {
      decorators: true,
      jsx: isJsx
    };
    const options = {
      module: ts.ModuleKind.ES2015,
      noResolve: true,
      target: ts.ScriptTarget.ES2016,
      experimentalDecorators: esOption.decorators,
      jsx: esOption.jsx ? "preserve" : undefined
    };

    const result = ts.transpileModule(tsCode, { compilerOptions: options });
    return result.outputText;
  }
}

module.exports = new Plugin();
