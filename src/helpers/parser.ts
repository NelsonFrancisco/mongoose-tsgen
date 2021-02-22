import mongoose from "mongoose";
import flatten, { unflatten } from "flat";
import glob from "glob";
import path from "path";
import * as fs from "fs";
import _ from "lodash";
import stripJsonComments from "strip-json-comments";
import { Project, SourceFile, SyntaxKind } from "ts-morph";

const MAIN_HEADER = `/* tslint:disable */\n/* eslint-disable */\n\n// ######################################## THIS FILE WAS GENERATED BY MONGOOSE-TSGEN ######################################## //\n\n// NOTE: ANY CHANGES MADE WILL BE OVERWRITTEN ON SUBSEQUENT EXECUTIONS OF MONGOOSE-TSGEN.`;
const IMPORTS = `import mongoose from "mongoose";`;
const MODULE_DECLARATION_HEADER = `declare module "mongoose" {`;
const MODULE_DECLARATION_FOOTER = "}";

const getObjectDocs = (modelName: string) => `/**
 * Lean version of ${modelName}Document (type alias of \`${modelName}\`)
 * 
 * Use this type alias to avoid conflicts with model names:
 * \`\`\`
 * import { ${modelName} } from "../models"
 * import { ${modelName}Object } from "../interfaces/mongoose.gen.ts"
 * 
 * const ${modelName.toLowerCase()}Object: ${modelName}Object = ${modelName.toLowerCase()}.toObject();
 * \`\`\`
 */`;

const getQueryDocs = (modelName: string) => `/**
 * Mongoose Query types
 * 
 * Use type assertion to ensure ${modelName} query type safety:
 * \`\`\`
 * ${modelName}Schema.query = <${modelName}Queries>{ ... };
 * \`\`\`
 */`;

const getMethodDocs = (modelName: string) => `/**
 * Mongoose Method types
 * 
 * Use type assertion to ensure ${modelName} methods type safety:
 * \`\`\`
 * ${modelName}Schema.methods = <${modelName}Methods>{ ... };
 * \`\`\`
 */`;

const getStaticDocs = (modelName: string) => `/**
 * Mongoose Static types
 * 
 * Use type assertion to ensure ${modelName} statics type safety:
 * \`\`\`
 * ${modelName}Schema.statics = <${modelName}Statics>{ ... };
 * \`\`\`
 */`;

const getModelDocs = (modelName: string) => `/**
 * Mongoose Model type
 * 
 * Pass this type to the Mongoose Model constructor:
 * \`\`\`
 * const ${modelName} = mongoose.model<${modelName}Document, ${modelName}Model>("${modelName}", ${modelName}Schema);
 * \`\`\`
 */`;

const getSchemaDocs = (modelName: string) => `/**
 * Mongoose Schema type
 * 
 * Assign this type to new ${modelName} schema instances:
 * \`\`\`
 * const ${modelName}Schema: ${modelName}Schema = new mongoose.Schema({ ... })
 * \`\`\`
 */`;

// If model is a subdoc, pass `fullName`
const getLeanDocs = (modelName: string, fullName?: string) => `/**
 * Lean version of ${fullName ?? modelName}Document
 * 
 * This has all Mongoose getters & functions removed. This type will be returned from \`${modelName}Document.toObject()\`.${
  !fullName || modelName === fullName ?
    ` To avoid conflicts with model names, use the type alias \`${modelName}Object\`.` :
    ""
}
 * \`\`\`
 * const ${modelName.toLowerCase()}Object = ${modelName.toLowerCase()}.toObject();
 * \`\`\`
 */`;

const getSubdocumentDocs = (modelName: string, path: string) => `/**
 * Mongoose Embedded Document type
 * 
 * Type of \`${modelName}Document["${path}"]\` element.
 */`;

const getDocumentDocs = (modelName: string) => `/**
 * Mongoose Document type
 * 
 * Pass this type to the Mongoose Model constructor:
 * \`\`\`
 * const ${modelName} = mongoose.model<${modelName}Document, ${modelName}Model>("${modelName}", ${modelName}Schema);
 * \`\`\`
 */`;

// TODO: simplify this conditional
const shouldLeanIncludeVirtuals = (schema: any) => {
  // Check the toObject options to determine if virtual property should be included.
  // See https://mongoosejs.com/docs/api.html#document_Document-toObject for toObject option documentation.
  const toObjectOptions = schema.options?.toObject ?? {};
  if (
    (!toObjectOptions.virtuals && !toObjectOptions.getters) ||
    (toObjectOptions.virtuals === false && toObjectOptions.getters === true)
  )
    return false;
  return true;
};

const makeLine = ({
  key,
  val,
  isOptional = false,
  newline = true
}: {
  key: string;
  val: string;
  isOptional?: boolean;
  newline?: boolean;
}) => {
  let line = "";

  if (key) {
    line += key;
    if (isOptional) line += "?";
    line += ": ";
  }
  line += val + ";";
  if (newline) line += "\n";
  return line;
};

const getFuncType = (
  funcSignature: string,
  funcType: "methods" | "statics" | "query",
  modelName: string
) => {
  const [, params, returnType] = funcSignature.match(/\((?:this: \w*(?:, )?)?(.*)\) => (.*)/) ?? [];
  let type;
  if (funcType === "query") {
    // query funcs always must return a query
    type = `<Q extends mongoose.Query<any, ${modelName}Document>>(this: Q${
      params?.length > 0 ? ", " + params : ""
    }) => Q`;
  } else if (funcType === "methods") {
    type = `(this: ${modelName}Document${params?.length > 0 ? ", " + params : ""}) => ${
      returnType ?? "any"
    }`;
  } else {
    type = `(this: ${modelName}Model${params?.length > 0 ? ", " + params : ""}) => ${
      returnType ?? "any"
    }`;
  }
  return type;
};

type ModelTypes = {
  [modelName: string]: {
    methods: { [funcName: string]: string };
    statics: { [funcName: string]: string };
    query: { [funcName: string]: string };
    virtuals: { [virtualName: string]: string };
  };
};

export const replaceModelTypes = (
  sourceFile: SourceFile,
  modelTypes: ModelTypes,
  schemas: LoadedSchemas,
  isAugmented: boolean
) => {
  const getRoot = () => {
    if (isAugmented)
      return (
        sourceFile
          .getFirstChildByKind(SyntaxKind.ModuleDeclaration)
          ?.getFirstChildByKind(SyntaxKind.ModuleBlock) ?? sourceFile
      );

    return sourceFile;
  };

  Object.entries(modelTypes).forEach(([modelName, types]) => {
    const { methods, statics, query, virtuals } = types;

    // methods
    if (Object.keys(methods).length > 0) {
      getRoot()
        ?.getTypeAlias(`${modelName}Methods`)
        ?.getFirstChildByKind(SyntaxKind.TypeLiteral)
        ?.getChildrenOfKind(SyntaxKind.PropertySignature)
        .forEach(prop => {
          const newType = methods[prop.getName()];
          if (newType) {
            const funcType = getFuncType(newType, "methods", modelName);
            prop.setType(funcType);
          }
        });
    }

    // statics
    if (Object.keys(statics).length > 0) {
      getRoot()
        ?.getTypeAlias(`${modelName}Statics`)
        ?.getFirstChildByKind(SyntaxKind.TypeLiteral)
        ?.getChildrenOfKind(SyntaxKind.PropertySignature)
        .forEach(prop => {
          const newType = statics[prop.getName()];
          if (newType) {
            const funcType = getFuncType(newType, "statics", modelName);
            prop.setType(funcType);
          }
        });
    }

    // queries
    if (Object.keys(query).length > 0) {
      getRoot()
        ?.getTypeAlias(`${modelName}Queries`)
        ?.getFirstChildByKind(SyntaxKind.TypeLiteral)
        ?.getChildrenOfKind(SyntaxKind.PropertySignature)
        .forEach(prop => {
          const newType = query[prop.getName()];
          if (newType) {
            const funcType = getFuncType(newType, "query", modelName);
            prop.setType(funcType);
          }
        });
    }

    // virtuals
    if (Object.keys(virtuals).length > 0) {
      getRoot()
        ?.getInterface(`${modelName}Document`)
        ?.getChildrenOfKind(SyntaxKind.PropertySignature)
        .forEach(prop => {
          const newType = virtuals[prop.getName()];
          if (newType) prop.setType(newType);
        });

      // if toObject options indicate to include virtuals in lean, then also change types for lean doc
      if (shouldLeanIncludeVirtuals(schemas[modelName])) {
        getRoot()
          ?.getInterface(`${modelName}`)
          ?.getChildrenOfKind(SyntaxKind.PropertySignature)
          .forEach(prop => {
            const newType = virtuals[prop.getName()];
            if (newType) prop.setType(newType);
          });
      }
    }
  });
};

const getSubDocName = (path: string, modelName = "") => {
  let subDocName =
    modelName +
    path
      .split(".")
      .map((p: string) => p[0].toUpperCase() + p.slice(1))
      .join("");

  if (subDocName.endsWith("s")) subDocName = subDocName.slice(0, -1);
  return subDocName;
};

const parseFunctions = (
  funcs: any,
  modelName: string,
  funcType: "methods" | "statics" | "query"
) => {
  let interfaceString = "";

  Object.keys(funcs).forEach(key => {
    if (["initializeTimestamps"].includes(key)) return;

    const funcSignature = "(...args: any[]) => any";
    const type = getFuncType(funcSignature, funcType, modelName);
    interfaceString += makeLine({ key, val: type });
  });

  return interfaceString;
};

const convertBaseTypeToTs = (key: string, val: any, isDocument: boolean) => {
  let valType: string | undefined;
  // NOTE: ideally we check actual type of value to ensure its Schema.Types.Mixed (the same way we do with Schema.Types.ObjectId),
  // but this doesnt seem to work for some reason
  if (val.schemaName === "Mixed" || val.type?.schemaName === "Mixed") {
    valType = "any";
  } else {
    const mongooseType = val.type === Map ? val.of : val.type;
    switch (mongooseType) {
      case String:
      case "String":
        if (val.enum?.length > 0) {
          valType = `"` + val.enum.join(`" | "`) + `"`;
        } else valType = "string";
        break;
      case Number:
      case "Number":
        if (key !== "__v") valType = "number";
        break;
      case mongoose.Schema.Types.Decimal128:
      case mongoose.Types.Decimal128:
        valType = isDocument ? "mongoose.Types.Decimal128" : "number";
        break;
      case Boolean:
        valType = "boolean";
        break;
      case Date:
        valType = "Date";
        break;
      case Buffer:
      case "Buffer":
        valType = "Buffer";
        break;
      case mongoose.Schema.Types.ObjectId:
      case mongoose.Types.ObjectId:
      case "ObjectId": // _id fields have type set to the string "ObjectId"
        valType = "mongoose.Types.ObjectId";
        break;
      default:
        // this indicates to the parent func that this type is nested and we need to traverse one level deeper
        valType = "{}";
        break;
    }
  }

  return valType;
};

export const parseSchema = ({
  schema: schemaOriginal,
  modelName,
  addModel = false,
  isDocument,
  header = "",
  footer = "",
  isAugmented = false
}: {
  schema: any;
  modelName?: string;
  addModel?: boolean;
  isDocument: boolean;
  header?: string;
  footer?: string;
  isAugmented?: boolean;
}) => {
  let template = "";
  const schema = _.cloneDeep(schemaOriginal);

  if (schema.childSchemas?.length > 0 && modelName) {
    const flatSchemaTree: any = flatten(schema.tree, { safe: true });
    let childInterfaces = "";

    const processChild = (rootPath: string) => {
      return (child: any) => {
        const path = child.model.path;
        const isSubdocArray = child.model.$isArraySubdocument;
        const name = getSubDocName(path, rootPath);

        child.schema._isReplacedWithSchema = true;
        child.schema._inferredInterfaceName = name;
        child.schema._isSubdocArray = isSubdocArray;

        /**
         * for subdocument arrays, mongoose supports passing `default: undefined` to disable the default empty array created.
         * here we indicate this on the child schema using _isDefaultSetToUndefined so that the parser properly sets the `isOptional` flag
         */
        if (isSubdocArray) {
          const defaultValuePath = `${path}.default`;
          if (
            defaultValuePath in flatSchemaTree &&
            flatSchemaTree[defaultValuePath] === undefined
          ) {
            child.schema._isDefaultSetToUndefined = true;
          }
        }
        flatSchemaTree[path] = isSubdocArray ? [child.schema] : child.schema;

        // since we now will process this child by using the schema, we can remove any further nested properties in flatSchemaTree
        for (const key in flatSchemaTree) {
          if (key.startsWith(path) && key.length > path.length) {
            delete flatSchemaTree[key];
          }
        }

        let header = "";
        if (isDocument)
          header += isSubdocArray ? getSubdocumentDocs(rootPath, path) : getDocumentDocs(rootPath);
        else header += getLeanDocs(rootPath, name);

        header += isAugmented ? "\n" : "\nexport ";
        if (isDocument)
          header += `interface ${name}Document extends ${
            isSubdocArray ?
              "mongoose.Types.EmbeddedDocument" :
              `mongoose.Document<mongoose.Types.ObjectId>, ${name}Methods`
          } {\n`;
        else header += `interface ${name} {\n`;

        childInterfaces += parseSchema({
          schema: child.schema,
          modelName: name,
          header,
          isDocument,
          footer: `}\n\n`,
          isAugmented
        });
      };
    };

    schema.childSchemas.forEach(processChild(modelName));

    const schemaTree = unflatten(flatSchemaTree);
    schema.tree = schemaTree;
    template += childInterfaces;
  }

  if (!isDocument && schema.statics && modelName && addModel) {
    // add type alias to modelName so that it can be imported without clashing with the mongoose model
    template += getObjectDocs(modelName);
    template += `\n${isAugmented ? "" : "export "}type ${modelName}Object = ${modelName}\n\n`;

    if (Object.keys(schema.query)?.length > 0) {
      template += getQueryDocs(modelName);
      template += `\n${isAugmented ? "" : "export "}type ${modelName}Queries = {\n`;
      template += parseFunctions(schema.query ?? {}, modelName, "query");
      template += "}\n\n";

      // TODO: this should just be one declare module statement with a single interface that extends every {modelName}Queries
      template += `${
        isAugmented ? "" : `declare module "mongoose" {`
      }interface Query<ResultType, DocType extends Document> extends ${modelName}Queries {}${
        isAugmented ? "" : "}"
      }\n\n`;
    }

    template += getMethodDocs(modelName);
    template += `\n${isAugmented ? "" : "export "}type ${modelName}Methods = {\n`;
    template += parseFunctions(schema.methods, modelName, "methods");
    template += "}\n\n";

    template += getStaticDocs(modelName);
    template += `\n${isAugmented ? "" : "export "}type ${modelName}Statics = {\n`;
    template += parseFunctions(schema.statics, modelName, "statics");
    template += "}\n\n";

    const modelExtend = `mongoose.Model<${modelName}Document>`;

    template += getModelDocs(modelName);
    template += `\n${
      isAugmented ? "" : "export "
    }interface ${modelName}Model extends ${modelExtend}, ${modelName}Statics {}\n\n`;

    template += getSchemaDocs(modelName);
    template += `\n${
      isAugmented ? "" : "export "
    }type ${modelName}Schema = mongoose.Schema<${modelName}Document, ${modelName}Model>\n\n`;
  }

  template += header;

  const schemaTree = schema.tree;

  const parseKey = (key: string, valOriginal: any): string => {
    // if the value is an object, we need to deepClone it to ensure changes to `val` aren't persisted in parent function
    let val = _.isPlainObject(valOriginal) ? _.cloneDeep(valOriginal) : valOriginal;

    let valType;
    let isOptional = !val.required;

    let isArray = Array.isArray(val);

    // this means its a subdoc
    if (isArray) {
      val = val[0];
      // if _isDefaultSetToUndefined is set, it means this is a subdoc array with `default: undefined`, indicating that mongoose will not automatically
      // assign an empty array to the value. Therefore, isOptional = true. In other cases, isOptional is false since the field will be automatically initialized
      // with an empty array
      isOptional = val._isDefaultSetToUndefined ?? false;
    } else if (Array.isArray(val.type)) {
      val.type = val.type[0];
      isArray = true;

      /**
       * Arrays can also take the following format.
       * This is used when validation needs to be done on both the element itself and the full array.
       * This format implies `required: true`.
       *
       * ```
       * friends: {
       *   type: [
       *     {
       *       type: Schema.Types.ObjectId,
       *       ref: "User",
       *       validate: [
       *         function(userId: mongoose.Types.ObjectId) { return !this.friends.includes(userId); }
       *       ]
       *     }
       *   ],
       *   validate: [function(val) { return val.length <= 3; } ]
       * }
       * ```
       */
      if (val.type.type) {
        if (val.type.ref) val.ref = val.type.ref;
        val.type = val.type.type;
        isOptional = false;
      }
    }

    // if type is provided directly on property, expand it
    if (
      [
        String,
        "String",
        Number,
        "Number",
        Boolean,
        Date,
        Buffer,
        "Buffer",
        mongoose.Schema.Types.ObjectId,
        mongoose.Types.ObjectId,
        mongoose.Types.Decimal128,
        mongoose.Schema.Types.Decimal128
      ].includes(val)
    )
      val = { type: val };

    const isMap = val.type === Map;

    if (val._inferredInterfaceName) {
      valType = val._inferredInterfaceName + (isDocument ? "Document" : "");
    }
    // check for virtual properties
    else if (val.path && val.path && val.setters && val.getters) {
      // skip id property
      if (key === "id") return "";

      // if not lean doc and lean docs shouldnt include virtuals, ignore entry
      if (!isDocument && !shouldLeanIncludeVirtuals(schema)) return "";

      valType = "any";
      isOptional = false;
    } else if (
      key &&
      [
        "get",
        "set",
        "schemaName",
        "defaultOptions",
        "_checkRequired",
        "_cast",
        "checkRequired",
        "cast",
        "__v"
      ].includes(key)
    ) {
      return "";
    } else if (val.ref) {
      let docRef: string;

      docRef = val.ref.replace(`'`, "");
      if (docRef.includes(".")) {
        docRef = getSubDocName(docRef);
      }

      valType = isDocument ?
        `${docRef}Document["_id"] | ${docRef}Document` :
        `${docRef}["_id"] | ${docRef}`;
    } else {
      // _ids are always required
      if (key === "_id") isOptional = false;
      const convertedType = convertBaseTypeToTs(key, val, isDocument);

      if (convertedType === "{}") {
        // if we dont find it, go one level deeper
        // here we pass isAugmented: true to prevent `export ` from being prepended to the header
        valType = parseSchema({
          schema: { tree: val },
          header: "{\n",
          isDocument,
          footer: "}",
          isAugmented: true
        });

        isOptional = false;
      } else {
        valType = convertedType;
      }
    }

    if (!valType) return "";

    if (isMap) valType = isDocument ? `mongoose.Types.Map<${valType}>` : `Map<string, ${valType}>`;

    if (valType === "Buffer" && isDocument) valType = "mongoose.Types.Buffer";

    if (isArray) {
      if (isDocument)
        valType = `mongoose.Types.${val._isSubdocArray ? "Document" : ""}Array<` + valType + ">";
      else {
        // if valType includes a space, likely means its a union type (ie "number | string") so lets wrap it in brackets when adding the array to the type
        if (valType.includes(" ")) valType = `(${valType})`;
        valType = `${valType}[]`;
      }
    }

    return makeLine({ key, val: valType, isOptional });
  };

  Object.keys(schemaTree).forEach((key: string) => {
    const val = schemaTree[key];
    template += parseKey(key, val);
  });

  template += footer;

  return template;
};

export const registerUserTs = (basePath: string): (() => void) | null => {
  let pathToSearch: string;
  if (basePath.endsWith(".json")) pathToSearch = basePath;
  else pathToSearch = path.join(basePath, "**/tsconfig.json");

  const files = glob.sync(pathToSearch, { ignore: "**/node_modules/**" });

  if (files.length === 0) throw new Error(`No tsconfig.json file found at path "${basePath}"`);
  else if (files.length > 1)
    throw new Error(
      `Multiple tsconfig.json files found. Please specify a more specific --project value.\nPaths found: ${files}`
    );

  const foundPath = path.join(process.cwd(), files[0]);
  require("ts-node").register({ transpileOnly: true, project: foundPath });

  // handle path aliases
  const tsConfigString = fs.readFileSync(foundPath, "utf8");
  const tsConfig = JSON.parse(stripJsonComments(tsConfigString));
  if (tsConfig?.compilerOptions?.paths) {
    const cleanup = require("tsconfig-paths").register({
      baseUrl: process.cwd(),
      paths: tsConfig.compilerOptions.paths
    });

    return cleanup;
  }

  return null;
};

interface LoadedSchemas {
  [modelName: string]: mongoose.Schema;
}

export const loadSchemas = (modelsPaths: string[]) => {
  const schemas: LoadedSchemas = {};

  const checkAndRegisterModel = (obj: any): boolean => {
    if (!obj?.modelName || !obj?.schema) return false;
    schemas[obj.modelName] = obj.schema;
    return true;
  };

  // we check each file's export object for property names that would commonly export the schema.
  // Here is the priority (using the filename as a starting point to determine model name):
  // default export, model name (ie `User`), model name lowercase (ie `user`), collection name (ie `users`), collection name uppercased (ie `Users`).
  // If none of those exist, we assume the export object is set to the schema directly
  modelsPaths.forEach((singleModelPath: string) => {
    let exportedData;
    try {
      exportedData = require(singleModelPath);
    } catch (err) {
      if (err.message?.includes(`Cannot find module '${singleModelPath}'`))
        throw new Error(`Could not find a module at path ${singleModelPath}.`);
      else throw err;
    }

    // if exported data has a default export, use that
    if (checkAndRegisterModel(exportedData.default) || checkAndRegisterModel(exportedData)) return;

    // if no default export, look for a property matching file name
    const { name: filenameRoot } = path.parse(singleModelPath);

    // capitalize first char
    const modelName = filenameRoot.charAt(0).toUpperCase() + filenameRoot.slice(1);
    const collectionNameUppercased = modelName + "s";

    let modelNameLowercase = filenameRoot.endsWith("s") ? filenameRoot.slice(0, -1) : filenameRoot;
    modelNameLowercase = modelNameLowercase.toLowerCase();

    const collectionName = modelNameLowercase + "s";

    // check likely names that schema would be exported from
    if (
      checkAndRegisterModel(exportedData[modelName]) ||
      checkAndRegisterModel(exportedData[modelNameLowercase]) ||
      checkAndRegisterModel(exportedData[collectionName]) ||
      checkAndRegisterModel(exportedData[collectionNameUppercased])
    )
      return;

    // if none of those have it, check all properties
    for (const obj of Object.values(exportedData)) {
      if (checkAndRegisterModel(obj)) return;
    }

    throw new Error(
      `A module was found at ${singleModelPath}, but no exported models were found. Please ensure this file exports a Mongoose Model (preferably default export).`
    );
  });

  return schemas;
};

export const createSourceFile = (genPath: string) => {
  const project = new Project();
  const sourceFile = project.createSourceFile(genPath, "", { overwrite: true });
  return sourceFile;
};

export const generateTypes = ({
  sourceFile,
  schemas,
  isAugmented,
  imports = []
}: {
  sourceFile: SourceFile;
  schemas: LoadedSchemas;
  isAugmented: boolean;
  imports?: string[];
}) => {
  sourceFile.addStatements(writer => {
    writer.write(MAIN_HEADER).blankLine();
    // default imports
    writer.write(IMPORTS);
    // custom, user-defined imports
    if (imports.length > 0) writer.write(imports.join("\n"));

    writer.blankLine();
    // writer.write("if (true)").block(() => {
    //     writer.write("something;");
    // });

    if (isAugmented) writer.write(MODULE_DECLARATION_HEADER).blankLine();

    Object.keys(schemas).forEach(modelName => {
      const schema = schemas[modelName];

      // passing modelName causes childSchemas to be processed
      const leanInterfaceStr = parseSchema({
        schema,
        modelName,
        addModel: true,
        isDocument: false,
        header:
          getLeanDocs(modelName) + `\n${isAugmented ? "" : "export "}interface ${modelName} {\n`,
        footer: "}",
        isAugmented
      });

      writer.write(leanInterfaceStr).blankLine();

      // get type of _id to pass to mongoose.Document
      // not sure why schema doesnt have `tree` property
      const _idType = convertBaseTypeToTs("_id", (schema as any).tree._id, true);

      const documentInterfaceStr = parseSchema({
        schema,
        modelName,
        addModel: true,
        isDocument: true,
        header:
          getDocumentDocs(modelName) +
          `\n${
            isAugmented ? "" : "export "
          }interface ${modelName}Document extends mongoose.Document<${_idType}>, ${modelName}Methods {\n`,
        footer: "}",
        isAugmented
      });

      writer.write(documentInterfaceStr).blankLine();
    });

    if (isAugmented) writer.write(MODULE_DECLARATION_FOOTER);
  });

  return sourceFile;
};

export const saveFile = ({ sourceFile }: { sourceFile: SourceFile; genFilePath: string }) => {
  try {
    sourceFile.saveSync();
    // fs.writeFileSync(genFilePath, sourceFile.getFullText(), "utf8");
  } catch (err) {
    // if folder doesnt exist, create and then write again
    // if (err.message.includes("ENOENT: no such file or directory")) {
    //   console.log(`Path ${genFilePath} not found; creating...`);

    //   const { dir } = path.parse(genFilePath);
    //   mkdirp.sync(dir);

    //   fs.writeFileSync(genFilePath, sourceFile.getFullText(), "utf8");
    // }
    console.error(err);
    throw err;
  }
};
