import fs from "fs";
import path from "path";
import fm from "front-matter";
import { fileURLToPath } from "url";
import crypto from "crypto";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = {
  contentDir: path.join(__dirname, "../public/content"),
  outputFile: path.join(__dirname, "../public/content/index.json"),
  exclude: [".DS_Store", "index.json"],
};

function generateUUID() {
  return crypto.randomUUID();
}

// 获取或生成稳定的卷UUID
function getStableVolumeUUID(volumePath, volumeName) {
  const uuidFile = path.join(volumePath, ".volume_uuid");
  const metaFile = path.join(volumePath, "_volume.yml");

  try {
    // 检查是否存在现有的UUID文件
    if (fs.existsSync(uuidFile)) {
      const existingData = JSON.parse(fs.readFileSync(uuidFile, "utf-8"));

      // 检查卷名是否发生变化
      if (existingData.volumeName === volumeName) {
        return existingData.uuid; // 返回现有UUID
      }
    }

    // 生成新UUID
    const newUUID = generateUUID();

    // 保存UUID和卷名信息
    fs.writeFileSync(
      uuidFile,
      JSON.stringify({
        uuid: newUUID,
        volumeName: volumeName,
        updatedAt: new Date().toISOString(),
      }),
      "utf-8"
    );

    return newUUID;
  } catch (error) {
    console.error(`处理卷UUID失败: ${volumePath}`, error);
    return generateUUID(); // 出错时回退到生成新UUID
  }
}

function extractChapterNumber(name, frontmatter) {
  const fromName = name.match(/第(\d+)章/) || name.match(/(\d+)/);
  if (fromName && fromName[1]) return parseInt(fromName[1]);

  if (frontmatter.title) {
    const fromTitle =
      frontmatter.title.match(/第(\d+)章/) || frontmatter.title.match(/(\d+)/);
    if (fromTitle && fromTitle[1]) return parseInt(fromTitle[1]);
  }

  return frontmatter.order || frontmatter.index || 0;
}

// 计算中文字数（包括中文标点符号）
function countChineseCharacters(text) {
  // 匹配中文字符和中文标点
  const chineseRegex =
    /[\u4e00-\u9fa5|\u3002|\uff1f|\uff01|\uff0c|\u3001|\uff1b|\uff1a|\u201c|\u201d|\u2018|\u2019|\uff08|\uff09|\u300a|\u300b|\u3008|\u3009|\u3010|\u3011|\u300e|\u300f|\u300c|\u300d|\ufe43|\ufe44|\u3014|\u3015|\u2026|\u2014|\uff5e|\ufe4f|\uffe5]|\d+|[a-zA-Z\-]+/g;
  const matches = text.match(chineseRegex);
  return matches ? matches.length : 0;
}

// 确保日期是标准ISO格式（不提供fallback）
function normalizeDate(inputDate) {
  try {
    // 尝试解析输入日期
    const dateObj = new Date(inputDate);

    // 检查是否是有效日期
    if (isNaN(dateObj.getTime())) {
      throw new Error("Invalid date");
    }

    // 返回标准ISO格式
    return dateObj.toISOString();
  } catch (e) {
    // 如果转换失败，抛出错误让调用方处理
    throw new Error(`无法标准化日期: ${inputDate}`);
  }
}

async function generateIndex() {
  console.log("开始生成嵌套结构内容索引...");

  try {
    const volumes = fs
      .readdirSync(config.contentDir)
      .filter(
        (item) =>
          fs.statSync(path.join(config.contentDir, item)).isDirectory() &&
          !config.exclude.includes(item)
      );

    const nestedIndex = {};

    for (const volume of volumes) {
      const volumePath = path.join(config.contentDir, volume);

      // 获取稳定的卷UUID
      const volumeUUID = getStableVolumeUUID(volumePath, volume);

      nestedIndex[volume] = {
        volumeInfo: {
          uuid: volumeUUID,
          title: volume,
        },
        chapters: [],
      };

      // 读取卷元数据（如果有）
      const volumeMetaPath = path.join(volumePath, "_volume.yml");
      if (fs.existsSync(volumeMetaPath)) {
        try {
          const volumeMeta = fs.readFileSync(volumeMetaPath, "utf-8");
          nestedIndex[volume].volumeInfo = {
            ...nestedIndex[volume].volumeInfo,
            ...fm(volumeMeta).attributes,
          };
        } catch (e) {
          console.warn(`读取卷元数据失败: ${volumeMetaPath}`, e);
        }
      }

      const chapters = fs
        .readdirSync(volumePath)
        .filter(
          (file) => file.endsWith(".md") && !config.exclude.includes(file)
        );

      for (const chapter of chapters) {
        const filePath = path.join(volumePath, chapter);
        let content = fs.readFileSync(filePath, "utf-8");
        let { attributes: frontmatter, body } = fm(content);

        let shouldUpdateFile = false;

        // 生成缺失的title（使用文件名，不带.md后缀）
        if (!frontmatter.title) {
          frontmatter.title = chapter.replace(".md", "");
          shouldUpdateFile = true;
        }

        // 处理日期字段
        if (!frontmatter.date) {
          // 没有date字段时使用文件修改时间
          const stats = fs.statSync(filePath);
          frontmatter.date = new Date(stats.mtime).toISOString();
          shouldUpdateFile = true;
        } else {
          try {
            // 尝试标准化现有date字段
            const normalizedDate = normalizeDate(frontmatter.date);
            if (frontmatter.date !== normalizedDate) {
              frontmatter.date = normalizedDate;
              shouldUpdateFile = true;
            }
          } catch (e) {
            console.warn(`章节 ${chapter} 的日期格式无效: ${frontmatter.date}`);
            // 保持原样，不更新date字段
          }
        }

        // 生成缺失的length（计算中文字数）
        if (!frontmatter.length) {
          frontmatter.length = countChineseCharacters(body);
          shouldUpdateFile = true;
        }

        // 生成缺失的UUID
        if (!frontmatter.uuid) {
          frontmatter.uuid = generateUUID();
          shouldUpdateFile = true;
        }

        const { title, ...restFrontmatter } = frontmatter;

        const chapterObj = {
          title: frontmatter.title, // 使用处理后的title
          path: `content/${volume}/${chapter}`,
          uuid: restFrontmatter.uuid,
          ...restFrontmatter,
        };

        nestedIndex[volume].chapters.push(chapterObj);

        if (shouldUpdateFile) {
          const newContent = `---\n${yaml.dump(frontmatter)}---\n${body}`;
          fs.writeFileSync(filePath, newContent, "utf-8");
          console.log(`已更新 ${chapter} 的元数据`);
        }
      }

      nestedIndex[volume].chapters.sort((a, b) => {
        const aNum = extractChapterNumber(a.title, a);
        const bNum = extractChapterNumber(b.title, b);

        if (aNum === bNum) {
          return a.title.localeCompare(b.title);
        }
        return aNum - bNum;
      });
    }

    fs.writeFileSync(config.outputFile, JSON.stringify(nestedIndex, null, 2));
    console.log(`成功生成嵌套索引，共 ${volumes.length} 卷`);
  } catch (error) {
    console.error("生成嵌套索引失败:", error);
    process.exit(1);
  }
}

generateIndex();
