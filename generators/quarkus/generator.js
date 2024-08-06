import os from 'os';
import chalk from 'chalk';
import BaseApplicationGenerator from 'generator-jhipster/generators/base-application';
import {
    GENERATOR_BOOTSTRAP_APPLICATION,
    GENERATOR_DOCKER,
    GENERATOR_GRADLE,
    GENERATOR_JAVA,
    GENERATOR_LANGUAGES,
    GENERATOR_LIQUIBASE,
    GENERATOR_MAVEN,
    GENERATOR_SERVER,
} from 'generator-jhipster/generators';
import { createNeedleCallback } from 'generator-jhipster/generators/base/support';
import { CACHE_EXPIRE_AFTER_WRITE, CACHE_MAXIMUM_SIZE, DEFAULT_DATA_ACCESS } from '../constants.js';
import { serverFiles } from './files.js';
import { entityQuarkusFiles } from './entity-files.js';

export default class extends BaseApplicationGenerator {
    async beforeQueue() {
        await this.dependsOnJHipster(GENERATOR_BOOTSTRAP_APPLICATION);
        (await this.dependsOnJHipster(GENERATOR_JAVA)).generateEntities = false;
        await this.dependsOnJHipster(GENERATOR_SERVER);

        // TODO: this is needed for addJavaDefinition to work
        // How could I have known that?
        await this.dependsOnJHipster('jhipster:java:build-tool');
    }

    get [BaseApplicationGenerator.INITIALIZING]() {
        return this.asInitializingTaskGroup({
            async parseCommand() {
                await this.parseCurrentJHipsterCommand();
            },
        });
    }

    get [BaseApplicationGenerator.PROMPTING]() {
        return this.asPromptingTaskGroup({
            async promptCommand({ control }) {
                if (control.existingProject && this.options.askAnswered !== true) return;
                await this.promptCurrentJHipsterCommand();
            },
        });
    }

    get [BaseApplicationGenerator.CONFIGURING]() {
        return this.asConfiguringTaskGroup({
            async configureCommand() {
                await this.configureCurrentJHipsterCommandConfig();
            },
        });
    }

    get [BaseApplicationGenerator.COMPOSING]() {
        return this.asComposingTaskGroup({
            async composingTemplateTask() {
                await this.composeWithJHipster(GENERATOR_DOCKER);

                if (this.jhipsterConfigWithDefaults.buildTool === 'maven') {
                    await this.composeWithJHipster(GENERATOR_MAVEN);
                }
                if (this.jhipsterConfigWithDefaults.buildTool === 'gradle') {
                    await this.composeWithJHipster(GENERATOR_GRADLE);
                }

                const languagesGenerator = await this.composeWithJHipster(GENERATOR_LANGUAGES);
                languagesGenerator.writeJavaLanguageFiles = true;

                if (this.jhipsterConfigWithDefaults.databaseType === 'sql') {
                    const liquibaseGenerator = await this.composeWithJHipster(GENERATOR_LIQUIBASE);
                    liquibaseGenerator.injectLogs = false;
                    liquibaseGenerator.injectBuildTool = false;
                }
            },
        });
    }

    get [BaseApplicationGenerator.LOADING]() {
        return this.asLoadingTaskGroup({
            async loadCatalog({ application }) {
                this.loadJavaDependenciesFromGradleCatalog(application.javaDependencies);
            },
            async loadCommand({ application }) {
                await this.loadCurrentJHipsterCommandConfig(application);
            },
        });
    }

    get [BaseApplicationGenerator.PREPARING]() {
        return this.asPreparingTaskGroup({
            async preparingTemplateTask({ source, application }) {
                source.addEntryToCache = ({ entry }) => {
                    this.editFile(
                        `${application.srcMainResources}application.properties`,
                        createNeedleCallback({
                            contentToAdd:
                                `quarkus.hibernate-orm.cache."${entry}".expiration.max-idle=${CACHE_EXPIRE_AFTER_WRITE}\n` +
                                `quarkus.hibernate-orm.cache."${entry}".memory.object-count=${CACHE_MAXIMUM_SIZE}`,
                            needle: 'quarkus-hibernate-cache-add-entry',
                        }),
                    );
                };
            },
        });
    }

    get [BaseApplicationGenerator.PREPARING_EACH_ENTITY]() {
        return this.asPreparingTaskGroup({
            async prepareQuarkusRendering({ entity }) {
                entity.dataAccess = entity.dataAccess ?? DEFAULT_DATA_ACCESS;
                entity.viaService = entity.service !== 'no';
                entity.hasServiceImpl = entity.service === 'serviceImpl';
                entity.viaRepository = entity.dataAccess === 'repository';
                entity.paginationAny = entity.pagination !== 'no';
                entity.propertiesOnly = true;
                entity.fluentMethods = false;

                entity.dataAccessObject = entity.viaRepository ? `${entity.entityInstance}Repository` : entity.entityClass;
                entity.mapper = `${entity.entityInstance}Mapper`;
                entity.entityToDtoMethodReference = `${entity.mapper}::toDto`;
                entity.entityToDtoMethodInvocation = `${entity.mapper}.toDto`;
                entity.serviceClassName = entity.hasServiceImpl ? `${entity.entityClass}ServiceImpl` : `${entity.entityClass}Service`;
            },
        });
    }

    get [BaseApplicationGenerator.POST_PREPARING_EACH_ENTITY]() {
        return this.asPreparingTaskGroup({
            async prepareQuarkusRendering({ entity }) {
                entity.mapsIdAssoc = undefined;
                entity.primaryKeyType = entity.primaryKey.type;

                for (const relationship of entity.relationships) {
                    if (relationship.id) {
                        entity.mapsIdAssoc = relationship;
                        entity.primaryKeyType =
                            relationship.otherEntityName === 'user' && entity.authenticationType === 'oauth2'
                                ? 'String'
                                : entity.primaryKey.type;
                        break;
                    }
                }
                entity.isUsingMapsId = entity.mapsIdAssoc !== undefined;
                entity.fieldsContainOwnerManyToMany = entity.relationships.some(rel => rel.relationshipType === 'many-to-many');
                entity.fieldsContainEmbedded = entity.relationships.some(rel => rel.otherEntity.embedded);
            },
        });
    }

    get [BaseApplicationGenerator.WRITING]() {
        return this.asWritingTaskGroup({
            async writingTemplateTask({ application }) {
                await this.writeFiles({
                    sections: serverFiles,
                    context: application,
                });
            },
        });
    }

    get [BaseApplicationGenerator.WRITING_ENTITIES]() {
        return this.asWritingTaskGroup({
            async writeQuarkusServerFiles({ application, entities }) {
                for (const entity of entities.filter(entity => !entity.skipServer && !entity.builtIn)) {
                    this.writeFiles({
                        sections: entityQuarkusFiles,
                        context: { ...application, ...entity },
                    });
                }
            },
        });
    }

    get [BaseApplicationGenerator.POST_WRITING]() {
        return this.asPostWritingTaskGroup({
            addDependencies({ application, source }) {
                const { javaDependencies } = application;
                source.addJavaDefinition({
                    dependencies: [
                        { groupId: 'org.assertj', artifactId: 'assertj-core', version: javaDependencies['assertj-core'] },
                        {
                            groupId: 'com.tngtech.archunit',
                            artifactId: 'archunit-junit5-api',
                            version: javaDependencies['archunit-junit5-api'],
                        },
                        {
                            groupId: 'org.apache.camel.quarkus',
                            artifactId: 'camel-quarkus-jackson',
                            version: javaDependencies['camel-quarkus-jackson'],
                        },
                        { groupId: 'org.apache.commons', artifactId: 'commons-vfs2', version: javaDependencies['commons-vfs2'] },
                        { groupId: 'org.graalvm.nativeimage', artifactId: 'svm', version: javaDependencies['graal'] },
                        { groupId: 'org.mapstruct', artifactId: 'mapstruct', version: javaDependencies['mapstruct'] },
                        { groupId: 'org.mapstruct', artifactId: 'mapstruct-processor', version: javaDependencies['mapstruct-processor'] },
                        { groupId: 'com.github.cloudyrock.mongock', artifactId: 'mongock-bom', version: javaDependencies['mongock-bom'] },
                        {
                            groupId: 'com.tietoevry.quarkus',
                            artifactId: 'quarkus-resteasy-problem',
                            version: javaDependencies['quarkus-resteasy-problem'],
                        },
                        { groupId: 'com.github.tomakehurst', artifactId: 'wiremock-jre8', version: javaDependencies['wiremock'] },
                        {
                            groupId: 'com.github.dasniko',
                            artifactId: 'testcontainers-keycloak',
                            version: javaDependencies['testcontainers-keycloak'],
                        },
                    ],
                });

                source.addGradleDependencyCatalogPlugins([
                    {
                        id: 'com.gorylenko.gradle-git-properties',
                        pluginName: 'gradle-git-properties',
                        version: application.javaDependencies['gradle-git-properties'],
                        addToBuild: true,
                    },
                    {
                        id: 'org.openapi.generator',
                        pluginName: 'openapi-generator',
                        version: application.javaDependencies['openapi-generator'],
                        addToBuild: application.enableSwaggerCodegen,
                    },
                    {
                        id: 'com.github.node-gradle.node',
                        pluginName: 'node',
                        version: application.javaDependencies['gradle-node'],
                        addToBuild: !application.skipClient,
                    },
                    {
                        id: 'io.spring.nohttp',
                        pluginName: 'nohttp',
                        version: application.javaDependencies['no-http-checkstyle'],
                        addToBuild: true,
                    },
                    {
                        id: 'org.liquibase.gradle',
                        pluginName: 'liquibase',
                        version: application.javaDependencies['liquibase'],
                        addToBuild: application.databaseType === 'sql',
                    },
                    {
                        id: 'org.sonarqube',
                        pluginName: 'sonarqube',
                        version: application.javaDependencies['sonarqube'],
                        addToBuild: true,
                    },
                    {
                        id: 'com.github.andygoossens.gradle-modernizer-plugin',
                        pluginName: 'modernizer',
                        version: application.javaDependencies['modernizer'],
                        addToBuild: true,
                    },
                ]);
            },
            updatePackageJsonScripts({ application }) {
                this.packageJson.merge({
                    scripts: {
                        'ci:backend:test': 'npm run backend:info && npm run backend:doc:test && npm run backend:unit:test',
                    },
                });
                if (application.prodDatabaseTypeMysql) {
                    this.packageJson.merge({
                        scripts: {
                            'services:db:await': 'sleep 10',
                        },
                    });
                }
                if (application.buildToolGradle) {
                    this.packageJson.merge({
                        scripts: {
                            'ci:native:prod':
                                './gradlew build -Dquarkus.native.enabled=true -Dquarkus.package.jar.enabled=false -x webapp -x test',
                            'ci:e2e:dev': 'concurrently -k -s first "./gradlew" "npm run e2e:headless"',
                            'ci:e2e:server:start':
                                'java -jar build/quarkus-app/quarkus-run.$npm_package_config_packaging -Dquarkus.profile=$npm_package_config_default_environment',
                            'java:jar': './gradlew build -x test -x integrationTest',
                        },
                    });
                } else {
                    this.packageJson.merge({
                        scripts: {
                            'ci:native:prod': './mvnw verify -Pnative,-webapp',
                            'ci:e2e:dev': 'concurrently -k -s first "./mvnw" "npm run e2e:headless"',
                            'ci:e2e:server:start':
                                'java -jar target/quarkus-app/quarkus-run.$npm_package_config_packaging -Dquarkus.profile=$npm_package_config_default_environment',
                        },
                    });
                }
            },
        });
    }

    get [BaseApplicationGenerator.POST_WRITING_ENTITIES]() {
        return this.asPostWritingEntitiesTaskGroup({
            async postWritingEntitiesTemplateTask({ application, entities }) {
                for (const entity of entities.filter(entity => !entity.builtIn && !entity.skipServer)) {
                    if (entity.dtoMapstruct) {
                        this.editFile(
                            `${application.srcTestJava}/${application.packageFolder}/service/dto/${entity.dtoClass}Test.java`,
                            content =>
                                content
                                    .replaceAll('web.rest.TestUtil', 'TestUtil')
                                    .replaceAll('getId()', 'id')
                                    .replaceAll(/setId\((.+)\)/g, 'id = $1'),
                        );
                        this.editFile(
                            `${application.srcTestJava}/${application.packageFolder}/service/mapper/${entity.entityClass}MapperTest.java`,
                            content => content.replaceAll('getId()', 'id'),
                        );
                    }
                    this.editFile(
                        `${application.srcTestJava}/${application.packageFolder}/domain/${entity.persistClass}Test.java`,
                        content => content.replaceAll('web.rest.TestUtil', 'TestUtil'),
                    );
                }
            },
            updateCacheConfiguration({ source, entities, application }) {
                if (!application.enableHibernateCache) return;
                for (const entity of entities.filter(entity => !entity.builtIn && !entity.skipServer)) {
                    const entityCache = `${application.packageName}.domain.${entity.persistClass}`;
                    source.addEntryToCache({ entry: entityCache });
                    for (const relationship of entity.relationships.filter(rel => rel.collection)) {
                        source.addEntryToCache({ entry: `${entityCache}.${relationship.relationshipFieldNamePlural}` });
                    }
                }
            },
        });
    }

    get [BaseApplicationGenerator.END]() {
        return this.asEndTaskGroup({
            end() {
                this.log.ok('Quarkus application generated successfully.');

                let executable = 'mvnw';
                if (this.jhipsterConfigWithDefaults.buildTool === 'gradle') {
                    executable = 'gradlew';
                }
                let logMsgComment = '';
                if (os.platform() === 'win32') {
                    logMsgComment = ` (${chalk.yellow.bold(executable)} if using Windows Command Prompt)`;
                }
                this.log(chalk.green(`  Run your Quarkus application:\n  ${chalk.yellow.bold(`./${executable}`)}${logMsgComment}`));
            },
        });
    }
}
