import { describe, expect, it } from 'vitest';
import { fromFileWrite } from '../src/hook/intent.js';
import { parseCatalog } from '../src/jvm/gradle.js';
import { compareMaven, pickMavenVersion, pomDependencies, satisfiesMavenSpec } from '../src/jvm/maven.js';
import { parseFile } from '../src/tree/lockfiles.js';

describe('pom.xml', () => {
  const pom = `<project>
  <modelVersion>4.0.0</modelVersion>
  <parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.2.0</version></parent>
  <groupId>com.acme</groupId><artifactId>app</artifactId><version>1.4.0</version>
  <properties>
    <log4j.version>2.14.1</log4j.version>
    <jackson.version>\${jackson.base}.1</jackson.version>
    <jackson.base>2.13</jackson.base>
  </properties>
  <dependencyManagement><dependencies>
    <dependency><groupId>com.fasterxml.jackson</groupId><artifactId>jackson-bom</artifactId><version>\${jackson.version}</version><type>pom</type><scope>import</scope></dependency>
  </dependencies></dependencyManagement>
  <dependencies>
    <!-- <dependency><groupId>commented</groupId><artifactId>out</artifactId><version>1</version></dependency> -->
    <dependency>
      <groupId>org.apache.logging.log4j</groupId>
      <artifactId>log4j-core</artifactId>
      <version>\${log4j.version}</version>
    </dependency>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
    <dependency><groupId>com.acme</groupId><artifactId>shared</artifactId><version>\${project.version}</version></dependency>
    <dependency><groupId>x</groupId><artifactId>unresolved</artifactId><version>\${nope}</version></dependency>
    <dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.12</version><scope>test</scope></dependency>
  </dependencies>
  <build><plugins><plugin><artifactId>maven-surefire-plugin</artifactId><dependencies>
    <dependency><groupId>plugin</groupId><artifactId>dep</artifactId><version>1.0</version></dependency>
  </dependencies></plugin></plugins></build>
</project>`;

  it('reads coordinates, resolves properties and skips what it cannot know', () => {
    expect(pomDependencies(pom)).toEqual([
      { name: 'com.fasterxml.jackson:jackson-bom', spec: '2.13.1', dev: undefined },
      { name: 'org.apache.logging.log4j:log4j-core', spec: '2.14.1', dev: undefined },
      { name: 'com.acme:shared', spec: '1.4.0', dev: undefined },
      { name: 'junit:junit', spec: '4.12', dev: true },
    ]);
    const t = parseFile('/x/pom.xml', pom);
    expect(t).toMatchObject({ ecosystem: 'maven', kind: 'manifest' });
  });

  it('Maven versions and ranges', () => {
    expect(compareMaven('2.14.1', '2.9.0')).toBeGreaterThan(0);
    expect(compareMaven('6.0.0-M1', '6.0.0')).toBeLessThan(0);
    expect(satisfiesMavenSpec('1.5', '[1.0,2.0)')).toBe(true);
    expect(satisfiesMavenSpec('2.0', '[1.0,2.0)')).toBe(false);
    expect(satisfiesMavenSpec('1.2', '(,1.0],[1.2,)')).toBe(true);
    expect(satisfiesMavenSpec('1.4.2', '1.4.+')).toBe(true);
    expect(satisfiesMavenSpec('1.4.2', '1.4.2')).toBeUndefined();
    expect(pickMavenVersion('[2.0,3.0)', ['1.0', '2.1', '2.17.0', '3.0'])).toBe('2.17.0');
    expect(pickMavenVersion('latest.release', ['1.0'], '1.0')).toBe('1.0');
    expect(pickMavenVersion('9.9', ['1.0'])).toBeUndefined();
  });
});

describe('hook intents from JVM build files', () => {
  it('pom.xml and build.gradle writes: only added or re-versioned dependencies count', () => {
    const before = '<project><dependencies><dependency><groupId>a</groupId><artifactId>b</artifactId><version>1.0</version></dependency></dependencies></project>';
    const after = before.replace('</dependencies>', '<dependency><groupId>org.apache.logging.log4j</groupId><artifactId>log4j-core</artifactId><version>2.14.1</version></dependency></dependencies>');
    const intents = fromFileWrite('/p/pom.xml', after, before);
    expect(intents.map((i) => `${i.ecosystem}:${i.name} ${i.spec}${i.contextOnly ? ' (ctx)' : ''}`)).toEqual(['maven:org.apache.logging.log4j:log4j-core 2.14.1', 'maven:a:b 1.0 (ctx)']);
    expect(fromFileWrite('/p/pom.xml', before, before)).toEqual([]);

    const g0 = 'dependencies {\n  implementation(libs.spring.core)\n}\n';
    const toml = (v: string) => `[versions]\nspring = "${v}"\n[libraries]\nspring-core = { module = "org.springframework:spring-core", version.ref = "spring" }\n`;
    expect(fromFileWrite('/p/app/build.gradle.kts', g0, undefined, { 'libs.versions.toml': toml('5.3.18') }).map((i) => `${i.name} ${i.spec}`)).toEqual([
      'org.springframework:spring-core 5.3.18',
    ]);
    // Editing the catalog itself re-versions the library.
    expect(fromFileWrite('/p/gradle/libs.versions.toml', toml('6.1.0'), toml('5.3.18')).map((i) => `${i.ecosystem}:${i.name} ${i.spec}`)).toEqual([
      'maven:org.springframework:spring-core 6.1.0',
    ]);
  });
});

describe('Gradle', () => {
  const catalog = `[versions]
spring = "5.3.18"
jackson = { strictly = "2.13.0" }

[libraries]
spring-core = { module = "org.springframework:spring-core", version.ref = "spring" }
jackson_databind = { group = "com.fasterxml.jackson.core", name = "jackson-databind", version.ref = "jackson" }
guava = "com.google.guava:guava:31.0-jre"
boot-bom = { module = "org.springframework.boot:spring-boot-dependencies", version = "3.2.0" }
managed = { module = "org.slf4j:slf4j-api" }

[bundles]
web = ["spring-core", "jackson_databind"]

[plugins]
kotlin = { id = "org.jetbrains.kotlin.jvm", version = "2.0.0" }
`;

  it('version catalog: refs, inline versions, strict versions; BOM-managed entries left out', () => {
    const c = parseCatalog(catalog);
    expect([...c.libraries.entries()]).toEqual([
      ['spring.core', { name: 'org.springframework:spring-core', spec: '5.3.18' }],
      ['jackson.databind', { name: 'com.fasterxml.jackson.core:jackson-databind', spec: '2.13.0' }],
      ['guava', { name: 'com.google.guava:guava', spec: '31.0-jre' }],
      ['boot.bom', { name: 'org.springframework.boot:spring-boot-dependencies', spec: '3.2.0' }],
    ]);
    expect(c.bundles.get('web')).toEqual(['spring.core', 'jackson.databind']);
    expect(parseFile('gradle/libs.versions.toml', catalog).declared).toHaveLength(4);
  });

  it('build.gradle.kts: string notation, variables, platform(), catalog refs and bundles', () => {
    const kts = `
val springVersion = "5.3.18"
extra["okVersion"] = "4.9.0"
dependencies {
    implementation("org.springframework:spring-core:$springVersion")
    implementation(platform("org.springframework.boot:spring-boot-dependencies:3.2.0"))
    implementation("com.squareup.okhttp3:okhttp:\${okVersion}")
    implementation("org.slf4j:slf4j-api") // version from the platform
    implementation(kotlin("stdlib"))
    implementation(libs.guava)
    implementation(libs.bundles.web)
    testImplementation("junit:junit:4.13.2")
    // implementation("commented:out:1.0")
    runtimeOnly("x:computed:\${computeVersion()}")
}`;
    const t = parseFile('build.gradle.kts', kts, { 'libs.versions.toml': catalog });
    expect(t.declared).toEqual([
      { name: 'org.springframework:spring-core', spec: '5.3.18', dev: undefined },
      { name: 'org.springframework.boot:spring-boot-dependencies', spec: '3.2.0', dev: undefined },
      { name: 'com.squareup.okhttp3:okhttp', spec: '4.9.0', dev: undefined },
      { name: 'junit:junit', spec: '4.13.2', dev: true },
      { name: 'com.google.guava:guava', spec: '31.0-jre', dev: undefined },
      { name: 'org.springframework:spring-core', spec: '5.3.18', dev: undefined },
      { name: 'com.fasterxml.jackson.core:jackson-databind', spec: '2.13.0', dev: undefined },
    ]);
  });

  it('build.gradle (Groovy): quotes, no parentheses, map notation, gradle.properties', () => {
    const groovy = `
def guavaVersion = '31.0-jre'
dependencies {
    implementation 'com.google.guava:guava:' + guavaVersion
    implementation "com.google.guava:guava:$guavaVersion"
    api group: 'org.apache.commons', name: 'commons-text', version: '1.9'
    testImplementation "org.mockito:mockito-core:\${mockitoVersion}"
    annotationProcessor 'org.projectlombok:lombok:1.18.30@jar'
}`;
    expect(parseFile('build.gradle', groovy, { 'gradle.properties': 'mockitoVersion=5.0.0\n' }).declared).toEqual([
      { name: 'com.google.guava:guava', spec: '31.0-jre', dev: undefined },
      { name: 'org.mockito:mockito-core', spec: '5.0.0', dev: true },
      { name: 'org.projectlombok:lombok', spec: '1.18.30', dev: undefined },
      { name: 'org.apache.commons:commons-text', spec: '1.9', dev: undefined },
    ]);
  });

  it('gradle.lockfile: every resolved module, direct from the build script, test-only as dev', () => {
    const lock = [
      '# This is a Gradle generated file for dependency locking.',
      'org.springframework:spring-core:5.3.18=compileClasspath,runtimeClasspath',
      'org.springframework:spring-jcl:5.3.18=compileClasspath,runtimeClasspath',
      'junit:junit:4.13.2=testCompileClasspath,testRuntimeClasspath',
      'empty=annotationProcessor',
    ].join('\n');
    const t = parseFile('gradle.lockfile', lock, { 'build.gradle.kts': 'dependencies { implementation("org.springframework:spring-core:5.3.18") }' });
    expect(t.kind).toBe('lockfile');
    expect(t.packages).toEqual([
      { name: 'org.springframework:spring-core', version: '5.3.18', direct: true, dev: false },
      { name: 'org.springframework:spring-jcl', version: '5.3.18', direct: false, dev: false },
      { name: 'junit:junit', version: '4.13.2', direct: false, dev: true },
    ]);
  });
});
